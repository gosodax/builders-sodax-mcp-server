import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { ActionError } from "../services/swap/errors.js";
import { registerActionTool } from "./actionTool.js";

async function callFailingTool(error: unknown) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  // Non-empty annotations: the SDK reads an empty object here as a second input schema.
  registerActionTool(server, "test_action_tool", "Fails on purpose.", {}, { readOnlyHint: true }, async () => {
    throw error;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "test_action_tool", arguments: {} });
  await client.close();
  return result;
}

describe("registerActionTool", () => {
  it("returns an ActionError with its code, details and next step", async () => {
    const error = new ActionError("UNSUPPORTED_CHAIN", "No.", { nextStep: "Ask the user.", details: { hint: 1 } });
    const result = await callFailingTool(error);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "error",
      error: { code: "UNSUPPORTED_CHAIN", message: "No.", hint: 1 },
      nextStep: "Ask the user.",
    });
  });

  it("never lets details overwrite the code or message", async () => {
    const error = new ActionError("UNSUPPORTED_CHAIN", "No.", { details: { code: 404, message: "spoof" } });
    const result = await callFailingTool(error);
    expect(result.structuredContent).toMatchObject({ error: { code: "UNSUPPORTED_CHAIN", message: "No." } });
  });

  it("gives each code a default next step", async () => {
    const result = await callFailingTool(new ActionError("UPSTREAM_UNAVAILABLE", "Down."));
    expect(result.structuredContent).toMatchObject({ nextStep: expect.stringContaining("Retry in a minute") });
  });

  it("turns anything else into INTERNAL without leaking its message", async () => {
    const result = await callFailingTool(new Error("details that must stay server-side"));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "error", error: { code: "INTERNAL" } });
    expect(JSON.stringify(result)).not.toContain("must stay server-side");
  });
});
