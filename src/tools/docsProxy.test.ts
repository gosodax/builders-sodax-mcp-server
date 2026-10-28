import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UPSTREAM_TOOLS = [
  { name: "search_sodax_docs", description: "search", inputSchema: { type: "object" } },
  { name: "query_docs_filesystem_sodax_docs", description: "query", inputSchema: { type: "object" } },
];

/** Fake docs MCP; `upstream.down` makes every call fail, `upstream.hang` holds tools/list open. */
function makeUpstream() {
  const upstream = { down: false, hang: null as Promise<void> | null, listCalls: 0 };
  const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as { method?: string }) : {};
    if (upstream.down) throw new Error("upstream down");
    if (body.method === "tools/list") {
      upstream.listCalls++;
      if (upstream.hang) await upstream.hang;
    }
    const result = body.method === "tools/list" ? { tools: UPSTREAM_TOOLS } : {};
    const text = body.method ? `event: message\ndata: ${JSON.stringify({ result })}\n\n` : "";
    return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, text: async () => text };
  });
  return { upstream, fetchMock };
}

type Handler = () => Promise<{ content: Array<{ text: string }> }>;

/** Registers the docs tools on a fake server and returns docs_refresh's handler. */
async function loadDocsRefresh(): Promise<Handler> {
  const { registerDocsProxyTools } = await import("./docsProxy.js");
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as Handler),
  } as unknown as McpServer;
  await registerDocsProxyTools(server);
  const refresh = handlers.get("docs_refresh");
  if (!refresh) throw new Error("docs_refresh not registered");
  return refresh;
}

describe("docs_refresh", () => {
  const realFetch = globalThis.fetch;
  let upstream: ReturnType<typeof makeUpstream>["upstream"];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = makeUpstream();
    upstream = fake.upstream;
    globalThis.fetch = fake.fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("reaches upstream at most once per minute however often it is called", async () => {
    const refresh = await loadDocsRefresh();
    const callsAfterWarmup = upstream.listCalls;

    await refresh();
    await refresh();
    await refresh();
    expect(upstream.listCalls).toBe(callsAfterWarmup + 1);

    vi.advanceTimersByTime(61_000);
    await refresh();
    expect(upstream.listCalls).toBe(callsAfterWarmup + 2);
  });

  it("keeps the cached tools for other callers while a refresh is in flight", async () => {
    const refresh = await loadDocsRefresh();
    const { fetchDocsTools } = await import("../services/docsProxy.js");
    let release = () => {};
    upstream.hang = new Promise(resolve => {
      release = resolve;
    });

    const pending = refresh();
    await vi.waitFor(() => expect(upstream.listCalls).toBe(2));
    expect((await fetchDocsTools()).map(t => t.name)).toEqual(UPSTREAM_TOOLS.map(t => t.name));

    release();
    expect((await pending).content[0]?.text).toContain("Refreshed");
  });

  it("keeps serving the cached tools when a refresh fails", async () => {
    const refresh = await loadDocsRefresh();
    const { fetchDocsTools, getCachedDocsHealth } = await import("../services/docsProxy.js");
    upstream.down = true;

    await refresh();

    expect(await fetchDocsTools()).toHaveLength(UPSTREAM_TOOLS.length);
    expect(getCachedDocsHealth()).toEqual({ healthy: false, toolCount: UPSTREAM_TOOLS.length });
  });
});
