import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyError } from "./discord.js";
import {
  MCP_MAX_BATCH_SIZE,
  asyncHandler,
  createMcpLimiter,
  jsonErrorHandler,
  mcpGetNotAllowed,
} from "./httpGuards.js";
import { logger } from "./logger.js";

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
  /** The limiter on /mcp, as in index.ts. */
  async function limitedApp(limit: number): Promise<string> {
    const app = express();
    app.use(express.json());
    app.post("/mcp", createMcpLimiter(limit), (_req, res) => {
      res.json({ ok: true });
    });
    return serve(app);
  }

  const limitError = {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Too many MCP requests, please try again later." },
    id: null,
  };

  it("counts each message of a batch against the limit", async () => {
    const url = await limitedApp(5);

    const first = await post(`${url}/mcp`, JSON.stringify([rpc(1), rpc(2), rpc(3)]));
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-remaining")).toBe("2");
    const res = await post(`${url}/mcp`, JSON.stringify([rpc(4), rpc(5), rpc(6)]));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(limitError);
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(res.headers.get("ratelimit-reset"));
  });

  it("logs a refusal once per window, however many follow", async () => {
    const warn = vi.spyOn(logger, "warn");
    const url = await limitedApp(1);
    expect((await post(`${url}/mcp`, JSON.stringify(rpc(1)))).status).toBe(200);
    expect((await post(`${url}/mcp`, JSON.stringify(rpc(2)))).status).toBe(429);
    expect((await post(`${url}/mcp`, JSON.stringify(rpc(3)))).status).toBe(429);
    const limited = warn.mock.calls.filter(([, msg]) => msg === "Rate limited");
    expect(limited).toHaveLength(1);
    expect(limited[0][0]).toMatchObject({
      "http.route": "/mcp",
      "rate_limit.limit": 1,
      "rate_limit.window_ms": 60_000,
    });
  });

  it("logs the crossing once when a batch crosses the line, and not again for the next refusal", async () => {
    const warn = vi.spyOn(logger, "warn");
    const url = await limitedApp(5);
    expect((await post(`${url}/mcp`, JSON.stringify([rpc(1), rpc(2), rpc(3)]))).status).toBe(200);
    expect((await post(`${url}/mcp`, JSON.stringify([rpc(4), rpc(5), rpc(6)]))).status).toBe(429);
    expect((await post(`${url}/mcp`, JSON.stringify(rpc(7)))).status).toBe(429);
    const limited = warn.mock.calls.filter(([, msg]) => msg === "Rate limited");
    expect(limited).toHaveLength(1);
    expect(limited[0][0]).toMatchObject({ "http.route": "/mcp", "rate_limit.limit": 5 });
  });

  it("answers the limit with a JSON-RPC error on /mcp whatever its case or trailing slash", async () => {
    const url = await limitedApp(1);
    await post(`${url}/mcp`, JSON.stringify(rpc(1)));

    const onMcp = await post(`${url}/MCP/`, JSON.stringify(rpc(2)));

    expect(onMcp.status).toBe(429);
    expect(await onMcp.json()).toEqual(limitError);
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
    app.get(
      "/late-boom",
      asyncHandler(async (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" }).write("data: x\n\n");
        throw new Error("internal detail");
      }),
    );
    app.use(jsonErrorHandler);
    return serve(app);
  }

  it("names the refusal on the request's record even when the headers were already sent", () => {
    // A 4xx: no error record and no alert throttle for the tests after this one.
    const err = Object.assign(new Error("too large"), { status: 413, type: "entity.too.large" });
    const res = { headersSent: true, locals: {} as Record<string, unknown> };
    const next = vi.fn();
    jsonErrorHandler(err, { method: "POST", path: "/mcp" } as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.locals.refusal).toBe("BODY_TOO_LARGE");
  });

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

  it.each(["/mcp/", "/MCP"])("treats %s as /mcp, as Express routing does", async path => {
    const url = await errorApp();

    const res = await post(`${url}${path}`, "{bad");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
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

  it("logs and alerts on an error raised after the headers were sent", async () => {
    const url = await errorApp();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20 * 60_000);
    const logError = vi.spyOn(logger, "error");
    vi.mocked(notifyError).mockClear();

    // The response is cut off, so reading it fails.
    await fetch(`${url}/late-boom`)
      .then(res => res.text())
      .catch(() => {});

    expect(logError).toHaveBeenCalledWith({ err: expect.any(Error) }, "Unhandled HTTP error");
    expect(notifyError).toHaveBeenCalledWith("Unhandled error on GET /late-boom", expect.any(Error));
    logError.mockRestore();
    now.mockRestore();
  });
});
