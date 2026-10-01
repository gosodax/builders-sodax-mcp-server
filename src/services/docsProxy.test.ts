import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fake MCP endpoint: routes by JSON-RPC method and frames results as SSE, the
 * way the Mintlify docs MCP does. `tools/list` returns three upstream tools —
 * two read tools plus the write-capable `submit_feedback` — so we can assert
 * the allowlist drops the latter.
 */
function makeFetchMock() {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as { method?: string }) : {};
    let result: unknown = {};
    if (body.method === "tools/list") {
      result = {
        tools: [
          { name: "search_sodax_docs", description: "search", inputSchema: { type: "object" } },
          { name: "query_docs_filesystem_sodax_docs", description: "query", inputSchema: { type: "object" } },
          { name: "submit_feedback", description: "WRITE", inputSchema: { type: "object" } },
        ],
      };
    } else if (body.method === "tools/call") {
      result = { content: [{ type: "text", text: "ok" }] };
    }
    const text = body.method ? `event: message\ndata: ${JSON.stringify({ result })}\n\n` : "";
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () => text,
    } as unknown as Response;
  });
}

describe("docsProxy allowlist", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("registers only allowlisted read tools and drops submit_feedback", async () => {
    const { fetchDocsTools } = await import("./docsProxy.js");
    const names = (await fetchDocsTools()).map(t => t.name);

    expect(names).toContain("search_sodax_docs");
    expect(names).toContain("query_docs_filesystem_sodax_docs");
    expect(names).not.toContain("submit_feedback");
    expect(names).toHaveLength(2);
  });

  it("refuses to call a non-allowlisted upstream tool", async () => {
    const { callDocsTool } = await import("./docsProxy.js");
    const result = await callDocsTool("submit_feedback", { message: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown docs tool");
  });

  it("reports healthy with the allowlisted tool count", async () => {
    const { checkDocsHealth } = await import("./docsProxy.js");
    expect(await checkDocsHealth()).toEqual({ healthy: true, toolCount: 2 });
  });

  it("does not cache an empty allowlisted result — re-fetches after upstream recovers", async () => {
    // First response: only a non-allowlisted tool → allowlisted set is empty.
    const state = { onlyWrite: true };
    globalThis.fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as { method?: string }) : {};
      let result: unknown = {};
      if (body.method === "tools/list") {
        result = {
          tools: state.onlyWrite
            ? [{ name: "submit_feedback", description: "WRITE", inputSchema: { type: "object" } }]
            : [{ name: "search_sodax_docs", description: "search", inputSchema: { type: "object" } }],
        };
      }
      const text = body.method ? `event: message\ndata: ${JSON.stringify({ result })}\n\n` : "";
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => text,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { fetchDocsTools } = await import("./docsProxy.js");
    expect(await fetchDocsTools()).toHaveLength(0); // empty, must NOT be cached for the full TTL
    state.onlyWrite = false; // upstream recovers
    // force (startup warm-up) bypasses the short failure back-off
    expect((await fetchDocsTools({ force: true })).map(t => t.name)).toEqual(["search_sodax_docs"]);
  });

  it("backs off after a failed fetch instead of re-hitting upstream on every call", async () => {
    vi.useFakeTimers();
    try {
      const failing = vi.fn(async () => {
        throw new Error("upstream down");
      });
      globalThis.fetch = failing as unknown as typeof fetch;
      const { fetchDocsTools, clearDocsCache } = await import("./docsProxy.js");

      expect(await fetchDocsTools()).toEqual([]);
      const callsAfterFirst = failing.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      // Within the back-off window: served from cache, no upstream traffic.
      expect(await fetchDocsTools()).toEqual([]);
      expect(await fetchDocsTools()).toEqual([]);
      expect(failing.mock.calls.length).toBe(callsAfterFirst);

      // After the window: upstream is tried again (and recovers).
      globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
      vi.advanceTimersByTime(61_000);
      expect(await fetchDocsTools()).toHaveLength(2);

      // clearDocsCache (docs_refresh) also resets the back-off.
      globalThis.fetch = failing as unknown as typeof fetch;
      clearDocsCache();
      await fetchDocsTools();
      globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
      clearDocsCache();
      expect(await fetchDocsTools()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
