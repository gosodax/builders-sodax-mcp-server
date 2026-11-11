import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, seedToolRegistry } from "./server.js";
import { logger } from "./services/logger.js";
import { type ToolSelection, type Toolsets, describeProfiles, selectToolsets } from "./services/profiles.js";

// With the docs MCP unreachable only the docs meta-tools register, so the list is stable.
beforeEach(() => {
  // What fetch rejects with when the network is down.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A client connected in memory to a server with these toolsets. */
async function connect(toolsets: ToolSelection): Promise<Client> {
  const server = await createServer(toolsets);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** The fields of each "Tool call" record the spy saw. */
const toolCalls = (info: MockInstance) =>
  info.mock.calls.filter(([, msg]) => msg === "Tool call").map(([fields]) => fields);

async function toolList(toolsets: Toolsets) {
  const client = await connect(toolsets);
  // A server with no tools declares no tools capability, and tools/list then fails.
  const tools = client.getServerCapabilities()?.tools ? (await client.listTools()).tools : [];
  await client.close();
  return tools;
}

describe("a call the SDK refuses before any handler runs", () => {
  it("gets a Tool call record: an unknown tool as other, invalid arguments under the tool's name", async () => {
    const info = vi.spyOn(logger, "info");
    const client = await connect({ builder: true, swap: false });
    expect((await client.callTool({ name: "sodax_nope", arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: "sodax_get_intent", arguments: {} })).isError).toBe(true);
    await client.close();
    const records = toolCalls(info);
    expect(records).toContainEqual(
      expect.objectContaining({ "gen_ai.tool.name": "other", "tool.outcome": "error", "error.type": "TOOL_NOT_FOUND" }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        "gen_ai.tool.name": "sodax_get_intent",
        "tool.outcome": "error",
        "error.type": "INVALID_ARGUMENTS",
      }),
    );
    expect(JSON.stringify(records)).not.toContain("sodax_nope");
  });

  it("leaves a tool's own error result to the tool's record: one record, not two, naming the cause", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    const client = await connect({ builder: true, swap: false });
    // The data API is offline here, so the handler runs and returns its failure as isError.
    const result = await client.callTool({
      name: "sodax_get_intent",
      arguments: { intentHash: `0x${"ab".repeat(32)}` },
    });
    await client.close();
    expect(result.isError).toBe(true);
    // SODAX's side, not the caller's: a warning.
    expect(toolCalls(info)).toEqual([]);
    expect(toolCalls(warn)).toEqual([
      expect.objectContaining({
        "gen_ai.tool.name": "sodax_get_intent",
        "tool.outcome": "error",
        "error.type": "UPSTREAM_UNREACHABLE",
      }),
    ]);
  });

  it("names a swap tool called on a connection without a key", async () => {
    seedToolRegistry({ builder: true, swap: true });
    const info = vi.spyOn(logger, "info");
    const client = await connect({ builder: true, swap: false });
    expect((await client.callTool({ name: "sodax_swap_track", arguments: {} })).isError).toBe(true);
    await client.close();
    expect(toolCalls(info)).toContainEqual(
      expect.objectContaining({ "gen_ai.tool.name": "sodax_swap_track", "error.type": "TOOL_NOT_FOUND" }),
    );
  });
});

describe("builder tools", () => {
  // Recorded before profiles existed: names, descriptions, schemas and annotations must not change.
  it("match the recorded list", async () => {
    const tools = await toolList({ builder: true, swap: false });
    await expect(JSON.stringify(tools, null, 2)).toMatchFileSnapshot("__snapshots__/builder-tools.json");
  });

  it("never reach a swap-only connection", async () => {
    const builder = (await toolList({ builder: true, swap: false })).map(tool => tool.name);
    const swapOnly = (await toolList({ builder: false, swap: true })).map(tool => tool.name);
    expect(swapOnly.filter(name => builder.includes(name))).toEqual([]);
  });

  it("come with the swap tools on a connection that gets both", async () => {
    const builder = (await toolList({ builder: true, swap: false })).map(tool => tool.name);
    const swapOnly = (await toolList({ builder: false, swap: true })).map(tool => tool.name);
    const both = (await toolList({ builder: true, swap: true })).map(tool => tool.name);
    expect(swapOnly.length).toBeGreaterThan(0);
    expect(both.sort()).toEqual([...builder, ...swapOnly].sort());
  });
});

describe("instructions", () => {
  async function instructions(toolsets: ToolSelection): Promise<string> {
    const client = await connect(toolsets);
    const text = client.getInstructions() ?? "";
    await client.close();
    return text;
  }

  it("name only tools the connection has", async () => {
    const builder = await instructions({ builder: true, swap: false });
    const swap = await instructions({ builder: false, swap: true });
    expect(builder).toContain("sodax_check_chain_support");
    expect(builder).not.toContain("sodax_resolve_token");
    expect(swap).toContain("sodax_resolve_token");
    expect(swap).toContain("sodax_swap_track");
    expect(swap).toContain("sodax_swap_cancel");
    expect(swap).toContain(
      "again after retryAfterSec seconds while the result has one; after an error, follow its nextStep",
    );
    expect(swap).not.toContain("sodax_check_chain_support");
    expect(swap).not.toContain("sodax_relay_submit_tx");
    expect(await instructions({ builder: true, swap: true })).toBe(
      `${builder}\n\n${swap}\n\nFor a user's swap use the \`sodax_swap_*\` tools, not \`sodax_relay_submit_tx\`, \`sodax_get_transaction\` or \`sodax_get_solver_quote\`.`,
    );
  });

  it("tell a keyless default connection, last, that the swap tools need a key", async () => {
    const builder = await instructions({ builder: true, swap: false });
    const keyless = selectToolsets(undefined, { apiKey: "missing", swapToolsEnabled: true });
    expect(builder).not.toContain("x-api-key");
    expect(await instructions(keyless)).toBe(`${builder}\n\n${keyless.keyHint}`);
  });

  it("tell a builder connection, last, that its malformed key is dropped", async () => {
    const builder = await instructions({ builder: true, swap: false });
    const malformed = selectToolsets("builder", { apiKey: "malformed", swapToolsEnabled: false });
    expect(await instructions(malformed)).toBe(`${builder}\n\n${malformed.keyHint}`);
  });
});

// The MCP Registry manifest. The registry drops `tools` on publish; the list is hand-written docs, so it is
// checked against what a client gets.
describe("server.json", () => {
  const readJson = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"));
  const meta = readJson("server.json") as {
    version: string;
    description: string;
    remotes: { headers: { name: string; choices?: string[] }[] }[];
    tools: { name: string; description: string }[];
  };

  // The proxied docs tools change with docs.sodax.com, so only the docs meta-tools are listed.
  it("lists every static tool a keyed default connection gets, and nothing else", async () => {
    const served = (await toolList({ builder: true, swap: true })).map(tool => tool.name);
    expect(meta.tools.map(tool => tool.name).sort()).toEqual(served.sort());
  });

  it("gives every tool a description", () => {
    for (const tool of meta.tools) {
      expect(tool.description.trim(), `${tool.name} has no description`).not.toBe("");
    }
  });

  it("carries the package.json version (release-please bumps both)", () => {
    expect(meta.version).toBe(readJson("package.json").version);
  });

  it("offers every profile, under a description within the registry's 100 characters", () => {
    const profile = meta.remotes[0].headers.find(header => header.name === "x-sodax-profile");
    expect(profile?.choices?.slice().sort()).toEqual(Object.keys(describeProfiles(true)).sort());
    expect(meta.description.length).toBeLessThanOrEqual(100);
  });
});
