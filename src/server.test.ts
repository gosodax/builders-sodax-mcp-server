import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import { PROFILE_DESCRIPTIONS, type ToolSelection, type Toolsets, selectToolsets } from "./services/profiles.js";

// With the docs MCP unreachable only the docs meta-tools register, so the list is stable.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function toolList(toolsets: Toolsets) {
  const server = await createServer(toolsets);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  // A server with no tools declares no tools capability, and tools/list then fails.
  const tools = client.getServerCapabilities()?.tools ? (await client.listTools()).tools : [];
  await client.close();
  return tools;
}

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
    const server = await createServer(toolsets);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
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
    const keyless = selectToolsets(undefined, "missing");
    expect(builder).not.toContain("x-api-key");
    expect(await instructions(keyless)).toBe(`${builder}\n\n${keyless.keyHint}`);
  });

  it("tell a builder connection, last, that its malformed key is dropped", async () => {
    const builder = await instructions({ builder: true, swap: false });
    const malformed = selectToolsets("builder", "malformed");
    expect(await instructions(malformed)).toBe(`${builder}\n\n${malformed.keyHint}`);
  });
});

// The MCP Registry entry: its tool list is ours and hand-written, so it is checked against what a client gets.
describe("server.json", () => {
  const meta = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf-8")) as {
    description: string;
    remotes: { headers: { name: string; choices?: string[] }[] }[];
    tools: { name: string }[];
  };

  // The proxied docs tools change with docs.sodax.com, so only the docs meta-tools are listed.
  it("lists every static tool a keyed default connection gets, and nothing else", async () => {
    const served = (await toolList({ builder: true, swap: true })).map(tool => tool.name);
    expect(meta.tools.map(tool => tool.name).sort()).toEqual(served.sort());
  });

  it("offers every profile, under a description within the registry's 100 characters", () => {
    const profile = meta.remotes[0].headers.find(header => header.name === "x-sodax-profile");
    expect(profile?.choices?.slice().sort()).toEqual(Object.keys(PROFILE_DESCRIPTIONS).sort());
    expect(meta.description.length).toBeLessThanOrEqual(100);
  });
});
