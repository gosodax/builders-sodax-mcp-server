import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getRequestContext,
  parseApiKey,
  runWithRequestContext,
  setFallbackRequestContext,
  withoutCredentials,
} from "./requestContext.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  setFallbackRequestContext({});
});

describe("runWithRequestContext", () => {
  it("uses the fallback outside a request, and a request overrides it", () => {
    setFallbackRequestContext({ apiKey: "stdio" });
    expect(getRequestContext().apiKey).toBe("stdio");
    expect(runWithRequestContext({}, () => getRequestContext().apiKey)).toBeUndefined();
  });
});

describe("withoutCredentials", () => {
  it("keeps the ids the logs need and drops what a caller must not share", () => {
    const shared = runWithRequestContext(
      { apiKey: "sodax_k", partnerFee: { address: "0x1", bps: 10 } as never, requestId: "r1", clientId: "c1" },
      () => withoutCredentials(),
    );
    expect(shared).toEqual({ requestId: "r1", clientId: "c1" });
  });
});

describe("parseApiKey", () => {
  it("accepts a SODAX key, trimmed", () => {
    expect(parseApiKey(" sodax_test-key_1 ")).toBe("sodax_test-key_1");
  });

  it("accepts up to 128 chars and drops longer", () => {
    const longest = `sodax_${"a".repeat(122)}`;
    expect(parseApiKey(longest)).toBe(longest);
    expect(parseApiKey(`${longest}a`)).toBeUndefined();
  });

  const malformed = ["sk-live-abc123", "sodax_a, sodax_b", "Bearer sodax_a", '"sodax_a"', "sodax_a\nsodax_b"];
  it.each([undefined, "", ...malformed])("drops %j", value => {
    expect(parseApiKey(value)).toBeUndefined();
  });
});

function whoamiServer(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool("whoami", { inputSchema: { delayMs: z.number() } }, async ({ delayMs }) => {
    await sleep(delayMs);
    return { content: [{ type: "text", text: getRequestContext().apiKey ?? "none" }] };
  });
  return server;
}

const whoamiCall = (id: number, delayMs: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "whoami", arguments: { delayMs } },
});

// index.ts uses the Node StreamableHTTPServerTransport, a wrapper over this one;
// both dispatch to the tool handler inside handleRequest.
async function callerKeySeenByTool(apiKey: string, delayMs: number): Promise<string> {
  const server = whoamiServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(whoamiCall(1, delayMs)),
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
