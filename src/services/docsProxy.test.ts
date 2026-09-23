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
    expect(await fetchDocsTools()).toHaveLength(0); // empty, must NOT be cached
    state.onlyWrite = false; // upstream recovers
    expect((await fetchDocsTools()).map(t => t.name)).toEqual(["search_sodax_docs"]);
  });
});
