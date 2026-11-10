import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./index.js";
import { hashClientIp } from "./services/analytics.js";
import { MCP_MAX_BATCH_SIZE, MCP_REQUESTS_PER_MINUTE, SSE_MAX_SESSIONS_PER_IP } from "./services/httpGuards.js";
import { runWithRequestContext } from "./services/requestContext.js";
import { clearCache } from "./services/sodaxApi.js";

// The guards are unit-tested in httpGuards.test.ts; this checks index.ts wires them to the routes.

// Spied, not replaced: the test reads the context each request runs under.
vi.mock("./services/requestContext.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./services/requestContext.js")>();
  return { ...actual, runWithRequestContext: vi.fn(actual.runWithRequestContext) };
});
vi.mock("./services/discord.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/discord.js")>()),
  notifyError: vi.fn(async () => {}),
}));
vi.mock("./services/analytics.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./services/analytics.js")>();
  return { ...actual, hashClientIp: vi.fn(actual.hashClientIp) };
});
// No docs MCP fetch per connection.
vi.mock("./tools/docsProxy.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./tools/docsProxy.js")>()),
  registerDocsProxyTools: vi.fn(async () => {}),
}));

let server: Server;
let base: string;
const streams: AbortController[] = [];
// Fetch cancels the stream of a collected response, which would free its SSE session mid-test.
const held: Response[] = [];

beforeAll(async () => {
  server = createHttpApp(true).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  for (const stream of streams.splice(0)) stream.abort();
  held.length = 0;
  vi.restoreAllMocks();
  // Tests that touch the data API warm its cache; the upstream-key tests count every fetch.
  clearCache();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "route-test", version: "0" } },
});

// Each test sends from its own IP (trust proxy is on), so the per-IP limits don't carry over.
function post(path: string, body: string, ip: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Forwarded-For": ip,
      ...headers,
    },
    body,
  });
}

async function openSse(ip: string): Promise<Response> {
  const stream = new AbortController();
  streams.push(stream);
  const res = await fetch(`${base}/sse`, { headers: { "X-Forwarded-For": ip }, signal: stream.signal });
  held.push(res);
  return res;
}

/** Opens an SSE session and returns its reader and message endpoint. */
async function sseSession(ip: string) {
  const sse = await openSse(ip);
  const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
  const [, endpoint] = await readUntil(reader, /event: endpoint\ndata: (\S+)\n/);
  return { sse, reader, endpoint };
}

/** Reads the SSE stream until `match` shows up; the test times out if it never does. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, match: RegExp): Promise<RegExpMatchArray> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`SSE stream ended before ${match}`);
    text += decoder.decode(value, { stream: true });
    const found = text.match(match);
    if (found) return found;
  }
}

describe("HTTP routes", () => {
  it("runs each /mcp request under its own request id", async () => {
    const spy = vi.mocked(runWithRequestContext);
    spy.mockClear();
    await post("/mcp", JSON.stringify(initialize(1)), "198.51.100.41");
    await post("/mcp", JSON.stringify(initialize(2)), "198.51.100.42");
    const ids = spy.mock.calls.map(([context]) => context.requestId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it("reports on /health that unified logging is off here", async () => {
    // /health reads the network count upstream; this run answers it locally.
    const realFetch = fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      String(input).startsWith(base) ? realFetch(input, init) : Promise.resolve(new Response("[]", { status: 200 })),
    );
    const res = await realFetch(`${base}/health`, { headers: { "X-Forwarded-For": "198.51.100.43" } });
    expect(((await res.json()) as { unifiedLogging: unknown }).unifiedLogging).toEqual({ on: false });
  });

  it("sends each call's own x-api-key upstream, on /mcp and on each /messages POST", async () => {
    const local = globalThis.fetch;
    const keys: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith(base)) return local(input, init);
      keys.push(new Headers(init?.headers).get("x-api-key"));
      return Response.json({});
    });
    const call = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "sodax_get_supported_chains", arguments: {} },
      });

    const res = await post("/mcp", call(1), "198.51.100.40", { "x-api-key": "sodax_route_key_a" });
    expect(res.status).toBe(200);
    clearCache();
    const { reader, endpoint } = await sseSession("198.51.100.41");
    await post(endpoint, call(2), "198.51.100.41", { "x-api-key": "sodax_route_key_b" });
    await readUntil(reader, /event: message\ndata: .*"id":2/);
    expect(keys).toEqual(["sodax_route_key_a", "sodax_route_key_b"]);
  });

  it("answers GET /mcp with 405 and the allowed methods", async () => {
    const res = await fetch(`${base}/mcp`, { headers: { "X-Forwarded-For": "198.51.100.1" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
    expect((await res.json()).error.code).toBe(-32000);
  });

  it("answers invalid JSON on /mcp with a JSON-RPC parse error", async () => {
    const res = await post("/mcp", "{bad", "198.51.100.2");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("answers an oversized body on /mcp with 413 in JSON", async () => {
    const res = await post("/mcp", JSON.stringify({ pad: "x".repeat(101 * 1024) }), "198.51.100.3");
    expect(res.status).toBe(413);
    expect((await res.json()).jsonrpc).toBe("2.0");
  });

  it("refuses a batch over the cap on /mcp", async () => {
    // Not initialize: the MCP SDK refuses a batch holding one by itself, with the same code.
    const batch = Array.from({ length: MCP_MAX_BATCH_SIZE + 1 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }));
    const res = await post("/mcp", JSON.stringify(batch), "198.51.100.4");
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain(`at most ${MCP_MAX_BATCH_SIZE} messages`);
  });

  it("turns a throwing /mcp handler into a JSON 500 and keeps serving", async () => {
    vi.mocked(hashClientIp).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const failed = await post("/mcp", JSON.stringify(initialize(1)), "198.51.100.5");
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe(-32603);

    const res = await post("/mcp", JSON.stringify(initialize(2)), "198.51.100.5");
    expect(res.status).toBe(200);
    expect((await res.json()).result.serverInfo.name).toBe("builders-sodax-mcp-server");
  });

  it("keeps an SSE session open and answers its messages over the stream", async () => {
    const ip = "198.51.100.6";
    const { sse, reader, endpoint } = await sseSession(ip);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");

    const res = await post(endpoint, JSON.stringify(initialize(7)), ip);
    expect(res.status).toBe(202);
    await readUntil(reader, /event: message\ndata: .*"id":7/);
  });

  it("turns a throwing /sse handler into a JSON 500 and keeps serving", async () => {
    const ip = "198.51.100.8";
    vi.mocked(hashClientIp).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const failed = await openSse(ip);
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toBe("Internal Server Error");
    expect((await sseSession(ip)).sse.status).toBe(200);
  });

  it("turns a throwing /messages handler into a JSON 500 and keeps the session", async () => {
    const ip = "198.51.100.9";
    const { reader, endpoint } = await sseSession(ip);
    vi.spyOn(SSEServerTransport.prototype, "handlePostMessage").mockRejectedValueOnce(new Error("boom"));
    const failed = await post(endpoint, JSON.stringify(initialize(8)), ip);
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toBe("Internal Server Error");

    expect((await post(endpoint, JSON.stringify(initialize(9)), ip)).status).toBe(202);
    await readUntil(reader, /event: message\ndata: .*"id":9/);
  });

  it("counts /messages and /sse against the MCP rate limit", async () => {
    const ip = "198.51.100.10";
    // Under the global limit (100), so only the MCP limiter can refuse.
    for (let i = 0; i < MCP_REQUESTS_PER_MINUTE; i++) {
      expect((await post("/messages?sessionId=none", "{}", ip)).status).toBe(400);
    }
    expect((await post("/messages?sessionId=none", "{}", ip)).status).toBe(429);
    expect((await openSse(ip)).status).toBe(429);
  });

  it("answers the global limit on /mcp with a JSON-RPC error too", async () => {
    const ip = "198.51.100.12";
    // The global limiter (100 a minute) counts every route; /health doesn't touch the MCP limiter.
    await Promise.all(
      Array.from({ length: 100 }, () => fetch(`${base}/health`, { headers: { "X-Forwarded-For": ip } })),
    );
    const res = await post("/mcp", JSON.stringify(initialize(1)), ip);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toEqual({ code: -32000, message: "Too many requests, please try again later." });
  });

  it("doesn't count refused /sse connections against the per-IP cap", async () => {
    const ip = "198.51.100.50";
    for (let i = 0; i <= SSE_MAX_SESSIONS_PER_IP; i++) {
      const refused = await fetch(`${base}/sse?profile=bogus`, { headers: { "X-Forwarded-For": ip } });
      expect(refused.status).toBe(400);
    }
    expect((await openSse(ip)).status).toBe(200);
  });

  it("caps open SSE sessions per IP", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < SSE_MAX_SESSIONS_PER_IP; i++) expect((await openSse(ip)).status).toBe(200);
    const refused = await openSse(ip);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toContain("Too many open SSE sessions");
  });
});
