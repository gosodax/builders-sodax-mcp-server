import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getRequestContext, parseApiKey, runWithRequestContext, setFallbackRequestContext } from "./requestContext.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  setFallbackRequestContext({});
});

describe("runWithRequestContext", () => {
  it("keeps concurrent callers' keys apart", async () => {
    const read = async (delayMs: number) => {
      await sleep(delayMs);
      return getRequestContext().apiKey;
    };
    const [first, second] = await Promise.all([
      runWithRequestContext({ apiKey: "k1" }, () => read(20)),
      runWithRequestContext({ apiKey: "k2" }, () => read(0)),
    ]);
    expect([first, second]).toEqual(["k1", "k2"]);
  });

  it("uses the fallback outside a request, and a request overrides it", () => {
    setFallbackRequestContext({ apiKey: "stdio" });
    expect(getRequestContext().apiKey).toBe("stdio");
    expect(runWithRequestContext({}, () => getRequestContext().apiKey)).toBeUndefined();
  });
});

describe("parseApiKey", () => {
  it("accepts a SODAX key, trimmed", () => {
    expect(parseApiKey(" sodax_test-key_1 ")).toBe("sodax_test-key_1");
  });

  it.each([undefined, "", "sk-live-abc123", "sodax_a, sodax_b", "Bearer sodax_a"])("drops %j", value => {
    expect(parseApiKey(value)).toBeUndefined();
  });
});

// index.ts uses the Node StreamableHTTPServerTransport, a wrapper over this one;
// both dispatch to the tool handler inside handleRequest.
async function callerKeySeenByTool(apiKey: string, delayMs: number): Promise<string> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool("whoami", { inputSchema: { delayMs: z.number() } }, async ({ delayMs }) => {
    await sleep(delayMs);
    return { content: [{ type: "text", text: getRequestContext().apiKey ?? "none" }] };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: { delayMs } },
    }),
  });
  const response = await runWithRequestContext({ apiKey }, () => transport.handleRequest(request));
  const body = (await response.json()) as { result: { content: { text: string }[] } };
  return body.result.content[0]?.text ?? "";
}

describe("through the MCP SDK transport", () => {
  it("each tool call sees its own caller's key", async () => {
    const seen = await Promise.all([callerKeySeenByTool("k1", 20), callerKeySeenByTool("k2", 0)]);
    expect(seen).toEqual(["k1", "k2"]);
  });
});
