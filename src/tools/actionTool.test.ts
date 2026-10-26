import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { errWithoutUrls, logger } from "../services/logger.js";
import { clearAlerts } from "../services/swap/alerts.js";
import { ActionError } from "../services/swap/errors.js";
import { registerActionTool } from "./actionTool.js";

/** A tool that takes one string, `value`, and runs `run` with it. */
async function callTool(value: string, run: () => Promise<never | { status: string; nextStep: string }>) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  // Non-empty annotations: the SDK reads an empty object here as a second input schema.
  registerActionTool(server, "test_action_tool", "A test tool.", { value: z.string() }, { readOnlyHint: true }, run);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "test_action_tool", arguments: { value } });
  await client.close();
  return result;
}

const callFailingTool = (error: unknown) =>
  callTool("x", async () => {
    throw error;
  });

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearAlerts();
  errors = vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

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

  it("refuses a secret before the tool runs, naming the field, never the value", async () => {
    const run = vi.fn();
    const phrase = `${"abandon ".repeat(11)}about`;
    const result = await callTool(phrase, run);
    expect(result.structuredContent).toMatchObject({ error: { code: "SECRET_REJECTED", field: "value" } });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("abandon");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("abandon");
  });

  it("logs an unexpected error without any URL in it, and alerts once", async () => {
    await callFailingTool(new Error("request to https://rpc.example/KEY failed"));
    await callFailingTool(new Error("request to https://rpc.example/KEY failed"));
    const logged = errors.mock.calls.find(([fields]) => (fields as { err?: unknown }).err)?.[0] as { err: unknown };
    expect(JSON.stringify(errWithoutUrls(logged.err))).toContain("<url>");
    expect(JSON.stringify(errWithoutUrls(logged.err))).not.toContain("KEY");
    const alerts = errors.mock.calls.filter(([fields]) => (fields as { alert?: string }).alert === "swap_error");
    expect(alerts).toHaveLength(1);
    expect(alerts[0][0]).toMatchObject({ tool: "test_action_tool", code: "INTERNAL" });
  });

  it("alerts on a swap the service built wrong, but not on what the agent or an outage can fix", async () => {
    await callFailingTool(new ActionError("SWAP_MISMATCH", "Built a different swap."));
    await callFailingTool(new ActionError("RATE_LIMITED", "Slow down."));
    await callFailingTool(new ActionError("INVALID_ADDRESS", "Bad address."));
    const alerted = errors.mock.calls.map(([fields]) => (fields as { code?: string }).code).filter(Boolean);
    expect(alerted).toEqual(["SWAP_MISMATCH"]);
  });

  it("keeps two different failures with the same code apart", async () => {
    await callFailingTool(new ActionError("SWAP_MISMATCH", "The config doesn't agree."));
    await callFailingTool(new ActionError("SWAP_MISMATCH", "Built a different swap."));
    await callFailingTool(new ActionError("SWAP_MISMATCH", "Built a different swap."));
    const reasons = errors.mock.calls.map(([fields]) => (fields as { reason?: string }).reason).filter(Boolean);
    expect(reasons).toEqual(["The config doesn't agree.", "Built a different swap."]);
  });
});
