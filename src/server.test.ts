import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import { type ToolSelection, type Toolsets, selectToolsets } from "./services/profiles.js";

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
    expect(swap).not.toContain("sodax_check_chain_support");
    expect(await instructions({ builder: true, swap: true })).toBe(`${builder}\n\n${swap}`);
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
