import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { type MockInstance, afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootConfig, createHttpApp, serverGauges } from "./index.js";
import { createServer } from "./server.js";
import { MCP_MAX_BATCH_SIZE, MCP_REQUESTS_PER_MINUTE, SSE_MAX_SESSIONS_PER_IP } from "./services/httpGuards.js";
import { logger } from "./services/logger.js";
import { getRequestContext, runWithRequestContext } from "./services/requestContext.js";
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
// Spied, so a test can make a handler fail after the guards let the request through.
vi.mock("./server.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./server.js")>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
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
// The data API answers /health and tool calls; this suite never reaches it (100 parallel /health below).
const realFetch = fetch;
const upstreamStub = (...args: Parameters<typeof fetch>) =>
  String(args[0]).startsWith(base) ? realFetch(...args) : Promise.resolve(new Response("[]", { status: 200 }));

beforeAll(async () => {
  server = createHttpApp(true).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(upstreamStub);
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

/**
 * The "HTTP request" record with these fields: written when the response closes, just after the client has it.
 * Matched, not the first one, because an SSE stream aborted in afterEach writes its record during the next test.
 */
function httpRequestRecord(spy: MockInstance, match: Record<string, unknown>): Promise<Record<string, unknown>> {
  const matches = (fields: Record<string, unknown>) =>
    Object.entries(match).every(([key, value]) => fields[key] === value);
  return vi.waitFor(() => {
    const found = spy.mock.calls.find(([fields, msg]) => msg === "HTTP request" && matches(fields));
    expect(found).toBeDefined();
    return (found as [Record<string, unknown>])[0];
  });
}

describe("HTTP routes", () => {
  it("runs each /mcp request under its own request id", async () => {
    const spy = vi.mocked(runWithRequestContext);
    spy.mockClear();
    await post("/mcp", JSON.stringify(initialize(1)), "198.51.100.41");
    await post("/mcp", JSON.stringify(initialize(2)), "198.51.100.42");
    // Per request: the context logMcpRequests opens, then the handler's extension of it, same id.
    const ids = spy.mock.calls.map(([context]) => context.requestId);
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it("logs one HTTP request record per MCP request, under the id its tool call carries", async () => {
    // The id on the tool's record comes from the context at write time, so the spy reads it there.
    const contextIds = new Map<unknown, string | undefined>();
    const info = vi.spyOn(logger, "info").mockImplementation(((_: unknown, msg: unknown) => {
      contextIds.set(msg, getRequestContext().requestId);
    }) as never);
    const ip = "198.51.100.44";
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "sodax_get_supported_chains", arguments: {} },
    });
    // Routed like the handlers: "/MCP/" is /mcp.
    const res = await post("/MCP/", call, ip);
    expect(res.status).toBe(200);
    const health = await fetch(`${base}/health`, { headers: { "X-Forwarded-For": ip } });
    const fields = await httpRequestRecord(info, { "http.route": "/mcp", "mcp.method.name": "tools/call" });
    // The client gets the id to quote; /health isn't an MCP request and gets none.
    expect(res.headers.get("x-request-id")).toBe(fields["request.id"]);
    expect(health.headers.get("x-request-id")).toBeNull();
    expect(fields).toMatchObject({
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "duration.ms": expect.any(Number),
    });
    expect(fields["request.id"]).toMatch(/^[0-9a-f-]{36}$/);
    // No POSTHOG_CLIENT_ID_SECRET here, so no client hash: the plain one could be reversed to the IP.
    expect(fields["client.ip_hash"]).toBeUndefined();
    expect(contextIds.get("Tool call")).toBe(fields["request.id"]);
    expect(
      info.mock.calls.filter(([f, msg]) => msg === "HTTP request" && f["mcp.method.name"] === "tools/call"),
    ).toHaveLength(1);
    // /health is not an MCP request.
    expect(info.mock.calls.some(([fields, msg]) => msg === "HTTP request" && fields["http.route"] === "/health")).toBe(
      false,
    );
  });

  it("reports on /health that unified logging is off here", async () => {
    const res = await fetch(`${base}/health`, { headers: { "X-Forwarded-For": "198.51.100.43" } });
    expect(((await res.json()) as { unifiedLogging: unknown }).unifiedLogging).toEqual({ on: false });
  });

  it("sends each call's own x-api-key upstream, on /mcp and on each /messages POST", async () => {
    const keys: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith(base)) return realFetch(input, init);
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

  it("answers GET /mcp with 405 and the allowed methods, and logs the request", async () => {
    const info = vi.spyOn(logger, "info");
    const res = await fetch(`${base}/mcp`, { headers: { "X-Forwarded-For": "198.51.100.1" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
    expect((await res.json()).error.code).toBe(-32000);
    await httpRequestRecord(info, {
      "http.request.method": "GET",
      "http.route": "/mcp",
      "http.response.status_code": 405,
      "error.type": "METHOD_NOT_ALLOWED",
    });
  });

  it("answers invalid JSON on /mcp with a JSON-RPC parse error, and logs the request as other", async () => {
    const info = vi.spyOn(logger, "info");
    const res = await post("/mcp", "{bad", "198.51.100.2");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
    // body-parser leaves {} behind a failed parse: a body, with no protocol method in it.
    const fields = await httpRequestRecord(info, { "http.route": "/mcp", "http.response.status_code": 400 });
    expect(fields["mcp.method.name"]).toBe("other");
    expect(fields["error.type"]).toBe("INVALID_JSON");
  });

  it("logs a method the protocol doesn't know as other, so a client can't shape the record", async () => {
    const info = vi.spyOn(logger, "info");
    await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "Tools/LIST" }), "198.51.100.46");
    await httpRequestRecord(info, { "http.route": "/mcp", "mcp.method.name": "other" });
  });

  it("answers an oversized body on /mcp with 413 in JSON", async () => {
    const info = vi.spyOn(logger, "info");
    const res = await post("/mcp", JSON.stringify({ pad: "x".repeat(101 * 1024) }), "198.51.100.3");
    expect(res.status).toBe(413);
    expect((await res.json()).jsonrpc).toBe("2.0");
    await httpRequestRecord(info, { "http.route": "/mcp", "error.type": "BODY_TOO_LARGE" });
  });

  it("refuses a batch over the cap on /mcp", async () => {
    // Not initialize: the MCP SDK refuses a batch holding one by itself, with the same code.
    const batch = Array.from({ length: MCP_MAX_BATCH_SIZE + 1 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }));
    const info = vi.spyOn(logger, "info");
    const res = await post("/mcp", JSON.stringify(batch), "198.51.100.4");
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain(`at most ${MCP_MAX_BATCH_SIZE} messages`);
    await httpRequestRecord(info, {
      "http.route": "/mcp",
      "http.response.status_code": 400,
      "mcp.method.name": "batch",
      "error.type": "BATCH_TOO_LARGE",
    });
  });

  it("names the client from initialize, and the connection's profile and key status, never the key", async () => {
    const info = vi.spyOn(logger, "info");
    const key = "sodax_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    const res = await post("/mcp?profile=builder", JSON.stringify(initialize(1)), "198.51.100.47", {
      "x-api-key": key,
      "User-Agent": "test-agent/1.0",
    });
    expect(res.status).toBe(200);
    const fields = await httpRequestRecord(info, { "http.route": "/mcp", "mcp.method.name": "initialize" });
    expect(fields).toMatchObject({
      "mcp.client.name": "route-test",
      "mcp.client.version": "0",
      "mcp.protocol.version": "2025-03-26",
      "user_agent.original": "test-agent/1.0",
      "mcp.profile": "builder",
      "caller.key_status": "valid",
      "caller.key_hash": expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(fields["error.type"]).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain("sodax_abc");
  });

  it("cuts a client's name to 64 characters without control characters, and names no client off initialize", async () => {
    const info = vi.spyOn(logger, "info");
    const message = initialize(1);
    message.params.clientInfo.name = `a\u0000b\n${"c".repeat(100)}`;
    await post("/mcp", JSON.stringify(message), "198.51.100.48");
    const fields = await httpRequestRecord(info, { "http.route": "/mcp", "mcp.method.name": "initialize" });
    expect(fields["mcp.client.name"]).toBe(`ab${"c".repeat(62)}`);
    expect(fields).toMatchObject({ "mcp.profile": "all", "caller.key_status": "missing" });
    expect(fields["caller.key_hash"]).toBeUndefined();
    await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }), "198.51.100.48");
    const ping = await httpRequestRecord(info, { "http.route": "/mcp", "mcp.method.name": "ping" });
    expect(ping["mcp.client.name"]).toBeUndefined();
  });

  it("drops line separators from a client's name, and never leaves half an emoji at the cut", async () => {
    const info = vi.spyOn(logger, "info");
    const message = initialize(1);
    message.params.clientInfo.name = `a\u2028${"\u{1F600}".repeat(40)}`;
    await post("/mcp", JSON.stringify(message), "198.51.100.51");
    const fields = await httpRequestRecord(info, { "http.route": "/mcp", "mcp.method.name": "initialize" });
    expect(fields["mcp.client.name"]).toBe(`a${"\u{1F600}".repeat(31)}`);
  });

  it("names the setting a refused connection got wrong", async () => {
    const info = vi.spyOn(logger, "info");
    // A sessionId on any route but /messages names no session: it could be someone else's.
    const unknown = await post("/mcp?profile=bogus&sessionId=abc", JSON.stringify(initialize(1)), "198.51.100.49");
    expect(unknown.status).toBe(400);
    const profile = await httpRequestRecord(info, { "http.route": "/mcp", "error.type": "UNKNOWN_PROFILE" });
    // The value a client typed is never logged.
    expect(profile["mcp.profile"]).toBeUndefined();
    expect(profile["mcp.session.id_hash"]).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain("bogus");
    const keyless = await post("/mcp?profile=swap", JSON.stringify(initialize(1)), "198.51.100.49", {
      "x-api-key": "not-a-key",
    });
    expect(keyless.status).toBe(403);
    const key = await httpRequestRecord(info, { "http.route": "/mcp", "error.type": "API_KEY_MALFORMED" });
    expect(key).toMatchObject({ "mcp.profile": "swap", "caller.key_status": "malformed" });
    expect(key["caller.key_hash"]).toBeUndefined();
    expect(JSON.stringify(key)).not.toContain("not-a-key");
  });

  it("names a /messages POST for a session that doesn't exist", async () => {
    const info = vi.spyOn(logger, "info");
    const res = await post("/messages?sessionId=nope", JSON.stringify(initialize(1)), "198.51.100.50");
    expect(res.status).toBe(400);
    const fields = await httpRequestRecord(info, { "http.route": "/messages", "error.type": "SSE_SESSION_NOT_FOUND" });
    // A message runs with its session's profile, named on that session's GET /sse.
    expect(fields["mcp.profile"]).toBeUndefined();
  });

  it("turns a throwing /mcp handler into a JSON 500 and keeps serving", async () => {
    const info = vi.spyOn(logger, "info");
    vi.mocked(createServer).mockRejectedValueOnce(new Error("boom"));
    const failed = await post("/mcp", JSON.stringify(initialize(1)), "198.51.100.5");
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe(-32603);
    // At info: the failure itself is the error handler's "Unhandled HTTP error" record, with the stack.
    await httpRequestRecord(info, { "http.route": "/mcp", "http.response.status_code": 500 });

    const res = await post("/mcp", JSON.stringify(initialize(2)), "198.51.100.5");
    expect(res.status).toBe(200);
    expect((await res.json()).result.serverInfo.name).toBe("builders-sodax-mcp-server");
  });

  it("keeps an SSE session open and answers its messages over the stream", async () => {
    const ip = "198.51.100.6";
    const { sse, reader, endpoint } = await sseSession(ip);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");

    const info = vi.spyOn(logger, "info");
    const res = await post(endpoint, JSON.stringify(initialize(7)), ip);
    expect(res.status).toBe(202);
    await readUntil(reader, /event: message\ndata: .*"id":7/);
    await httpRequestRecord(info, {
      "http.route": "/messages",
      "http.response.status_code": 202,
      "mcp.method.name": "initialize",
    });
  });

  it("names an SSE session by a hash of its id: when it opens, on its messages and on its close", async () => {
    const ip = "198.51.100.52";
    const info = vi.spyOn(logger, "info");
    const { reader, endpoint } = await sseSession(ip);
    const sessionId = new URL(endpoint, base).searchParams.get("sessionId") as string;
    const opened = info.mock.calls.find(([, msg]) => msg === "SSE session opened")?.[0] as Record<string, unknown>;
    const tag = opened["mcp.session.id_hash"];
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(info.mock.calls)).not.toContain(sessionId);
    await post(endpoint, JSON.stringify(initialize(7)), ip);
    await readUntil(reader, /"id":7/);
    await httpRequestRecord(info, { "http.route": "/messages", "mcp.session.id_hash": tag });
    // The open sessions are a heartbeat gauge, next to the others.
    expect(serverGauges()()).toMatchObject({
      "swap_quotes.open": expect.any(Number),
      "sse.sessions": expect.any(Number),
      "process.memory.rss_bytes": expect.any(Number),
      "process.memory.heap_used_bytes": expect.any(Number),
      "event_loop.delay_p99_ms": expect.any(Number),
      "docs_proxy.healthy": expect.any(Boolean),
    });
    expect(serverGauges()()["sse.sessions"]).toBeGreaterThanOrEqual(1);
    streams.splice(0).forEach(stream => stream.abort());
    await httpRequestRecord(info, { "http.route": "/sse", "mcp.session.id_hash": tag });
  });

  it("turns a throwing /sse handler into a JSON 500 and keeps serving", async () => {
    const ip = "198.51.100.8";
    vi.mocked(createServer).mockRejectedValueOnce(new Error("boom"));
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
    const debug = vi.spyOn(logger, "debug");
    const warn = vi.spyOn(logger, "warn");
    const res = await post("/mcp", JSON.stringify(initialize(1)), ip);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toEqual({ code: -32000, message: "Too many requests, please try again later." });
    // Refused before the body was parsed, and at debug: the limiter's own record is the one that ships.
    const fields = await httpRequestRecord(debug, { "http.route": "/mcp", "http.response.status_code": 429 });
    expect(fields["error.type"]).toBe("RATE_LIMITED");
    expect(fields["mcp.method.name"]).toBeUndefined();
    // Once per window, however many refusals follow.
    expect((await post("/mcp", JSON.stringify(initialize(2)), ip)).status).toBe(429);
    const limited = warn.mock.calls.filter(([, msg]) => msg === "Rate limited");
    expect(limited).toHaveLength(1);
    expect(limited[0][0]).toMatchObject({
      "http.route": "/mcp",
      "rate_limit.limit": 100,
      "rate_limit.window_ms": 60_000,
    });
  });

  it("names no route a client made up when the global limiter refuses it", async () => {
    const ip = "198.51.100.13";
    const warn = vi.spyOn(logger, "warn");
    const path = "/sodax_made_up_path_that_looks_like_a_key_0123456789";
    await Promise.all(
      Array.from({ length: 100 }, () => fetch(`${base}${path}`, { headers: { "X-Forwarded-For": ip } })),
    );
    expect((await fetch(`${base}${path}`, { headers: { "X-Forwarded-For": ip } })).status).toBe(429);
    const limited = warn.mock.calls.filter(([, msg]) => msg === "Rate limited");
    expect(limited).toHaveLength(1);
    expect(limited[0][0]).toMatchObject({ "http.route": "other" });
    expect(JSON.stringify(limited)).not.toContain("made_up");
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
    const info = vi.spyOn(logger, "info");
    const refused = await openSse(ip);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toContain("Too many open SSE sessions");
    await httpRequestRecord(info, { "http.route": "/sse", "error.type": "SSE_SESSION_LIMIT" });
  });
});

describe("the records about the server itself", () => {
  it("names how it was started: overridden RPCs by chain only, never a URL", () => {
    const config = bootConfig(
      { solana: { rpcUrl: "https://rpc.example/KEY" }, "0xa4b1.arbitrum": { rpcUrl: "x" } },
      true,
    );
    expect(config).toMatchObject({
      "app.version": expect.any(String),
      "sodax.env": expect.any(String),
      "swap_tools.enabled": true,
      "rpc_overrides.chains": "0xa4b1.arbitrum,solana",
      "posthog.enabled": false,
      "discord.enabled": expect.any(Boolean),
      "log.level": expect.any(String),
    });
    expect(JSON.stringify(config)).not.toContain("rpc.example");
    expect(bootConfig({}, false)["rpc_overrides.chains"]).toBeUndefined();
  });
});
