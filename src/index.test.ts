import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./index.js";
import { hashClientIp } from "./services/analytics.js";
import { MCP_MAX_BATCH_SIZE, SSE_MAX_SESSIONS_PER_IP } from "./services/httpGuards.js";

// The guards are unit-tested in httpGuards.test.ts; this checks index.ts wires them to the routes.

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
  server = createHttpApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  for (const stream of streams.splice(0)) stream.abort();
  held.length = 0;
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
function post(path: string, body: string, ip: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Forwarded-For": ip,
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
    const batch = Array.from({ length: MCP_MAX_BATCH_SIZE + 1 }, (_, i) => initialize(i));
    const res = await post("/mcp", JSON.stringify(batch), "198.51.100.4");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
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
    const sse = await openSse(ip);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    const [, endpoint] = await readUntil(reader, /event: endpoint\ndata: (\S+)\n/);

    const res = await post(endpoint, JSON.stringify(initialize(7)), ip);
    expect(res.status).toBe(202);
    await readUntil(reader, /event: message\ndata: .*"id":7/);
  });

  it("caps open SSE sessions per IP", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < SSE_MAX_SESSIONS_PER_IP; i++) expect((await openSse(ip)).status).toBe(200);
    const refused = await openSse(ip);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toContain("Too many open SSE sessions");
  });
});
