import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import type { Toolsets } from "./services/profiles.js";

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
});
