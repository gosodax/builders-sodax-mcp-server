import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyError } from "./discord.js";
import {
  MCP_MAX_BATCH_SIZE,
  SseSessionLimiter,
  asyncHandler,
  createMcpLimiter,
  jsonErrorHandler,
  mcpGetNotAllowed,
} from "./httpGuards.js";

vi.mock("./discord.js", () => ({ notifyError: vi.fn(async () => {}) }));

let server: Server | null = null;

async function serve(app: express.Express): Promise<string> {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise(resolve => server?.close(resolve));
  server = null;
});

const rpc = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });

function post(url: string, body: string): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

describe("createMcpLimiter", () => {
  async function limitedApp(limit: number): Promise<string> {
    const app = express();
    app.use(express.json());
    app.post("/mcp", createMcpLimiter(limit), (_req, res) => {
      res.json({ ok: true });
    });
    return serve(app);
  }

  it("counts each message of a batch against the limit", async () => {
    const url = await limitedApp(5);

    expect((await post(`${url}/mcp`, JSON.stringify([rpc(1), rpc(2), rpc(3)]))).status).toBe(200);
    const res = await post(`${url}/mcp`, JSON.stringify([rpc(4), rpc(5), rpc(6)]));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many MCP requests, please try again later." });
  });

  it("counts a single message once", async () => {
    const url = await limitedApp(2);

    expect((await post(`${url}/mcp`, JSON.stringify(rpc(1)))).status).toBe(200);
    expect((await post(`${url}/mcp`, JSON.stringify(rpc(2)))).status).toBe(200);
    expect((await post(`${url}/mcp`, JSON.stringify(rpc(3)))).status).toBe(429);
  });

  it("refuses a batch larger than the cap with a JSON-RPC error", async () => {
    const url = await limitedApp(1000);
    const batch = Array.from({ length: MCP_MAX_BATCH_SIZE + 1 }, (_, i) => rpc(i));

    const res = await post(`${url}/mcp`, JSON.stringify(batch));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });
  });
});

describe("mcpGetNotAllowed", () => {
  it("answers GET with 405 and a JSON-RPC error instead of opening a stream", async () => {
    const app = express();
    app.get("/mcp", mcpGetNotAllowed);
    const url = await serve(app);

    const res = await fetch(`${url}/mcp`, { headers: { Accept: "text/event-stream" } });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
  });
});

describe("SseSessionLimiter", () => {
  it("caps sessions per IP and frees a slot on release", () => {
    const limiter = new SseSessionLimiter(10, 2, 1000);
    const a = limiter.open("1.1.1.1", () => {});
    const b = limiter.open("1.1.1.1", () => {});

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(limiter.open("1.1.1.1", () => {})).toBeNull();
    expect(limiter.open("2.2.2.2", () => {})).not.toBeNull();

    a?.release();
    a?.release(); // a second release must not free another slot
    expect(limiter.open("1.1.1.1", () => {})).not.toBeNull();
    expect(limiter.open("1.1.1.1", () => {})).toBeNull();
  });

  it("caps sessions globally across IPs", () => {
    const limiter = new SseSessionLimiter(2, 5, 1000);
    limiter.open("1.1.1.1", () => {});
    const second = limiter.open("2.2.2.2", () => {});

    expect(limiter.open("3.3.3.3", () => {})).toBeNull();
    second?.release();
    expect(limiter.open("3.3.3.3", () => {})).not.toBeNull();
  });

  it("ends a session after the idle timeout, restarted by touch()", () => {
    vi.useFakeTimers();
    try {
      const onIdle = vi.fn();
      const lease = new SseSessionLimiter(10, 10, 1000).open("1.1.1.1", onIdle);

      vi.advanceTimersByTime(900);
      lease?.touch();
      vi.advanceTimersByTime(900);
      expect(onIdle).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(onIdle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the idle timer on release", () => {
    vi.useFakeTimers();
    try {
      const onIdle = vi.fn();
      new SseSessionLimiter(10, 10, 1000).open("1.1.1.1", onIdle)?.release();

      vi.advanceTimersByTime(5000);
      expect(onIdle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("jsonErrorHandler", () => {
  async function errorApp(): Promise<string> {
    const app = express();
    app.use(express.json({ limit: "1kb" }));
    app.post("/mcp", (_req, res) => {
      res.json({ ok: true });
    });
    app.post("/other", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/boom", () => {
      throw new Error("internal detail");
    });
    app.get(
      "/async-boom",
      asyncHandler(async () => {
        throw new Error("internal detail");
      }),
    );
    app.use(jsonErrorHandler);
    return serve(app);
  }

  it("answers malformed JSON on /mcp with a JSON-RPC parse error", async () => {
    const url = await errorApp();

    const res = await post(`${url}/mcp`, "{bad");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: invalid JSON" },
      id: null,
    });
  });

  it("answers an oversized body on /mcp with 413 and a JSON-RPC error", async () => {
    const url = await errorApp();

    const res = await post(`${url}/mcp`, JSON.stringify({ a: "x".repeat(2000) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });
  });

  it("answers malformed JSON elsewhere with a plain JSON error", async () => {
    const url = await errorApp();

    const res = await post(`${url}/other`, "{bad");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Parse error: invalid JSON" });
  });

  it.each(["/boom", "/async-boom"])("answers an unexpected error in %s with 500 and no details", async path => {
    const url = await errorApp();

    const res = await fetch(`${url}${path}`);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(text)).toEqual({ error: "Internal Server Error" });
    expect(text).not.toContain("internal detail");
  });

  it("alerts on unexpected errors at most once a minute, and never on client errors", async () => {
    const url = await errorApp();
    const start = Date.now() + 10 * 60_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    vi.mocked(notifyError).mockClear();

    await fetch(`${url}/boom`);
    await fetch(`${url}/async-boom`);
    await post(`${url}/mcp`, "{bad");
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith("Unhandled error on GET /boom", expect.any(Error));

    now.mockReturnValue(start + 60_000);
    await fetch(`${url}/boom`);
    expect(notifyError).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});
