import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import { type Toolsets, selectToolsets } from "./services/profiles.js";

// With the docs MCP unreachable only the docs meta-tools register, so the list is stable.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connect(toolsets: Toolsets): Promise<Client> {
  const server = await createServer(toolsets);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function listedTools(toolsets: Toolsets): Promise<string> {
  const client = await connect(toolsets);
  const { tools } = await client.listTools();
  await client.close();
  return JSON.stringify(tools, null, 2);
}

describe("builder tools", () => {
  // Recorded before profiles existed: names, descriptions, schemas and annotations must not change.
  const SNAPSHOT = "__snapshots__/builder-tools.json";

  it("match the recorded list", async () => {
    await expect(await listedTools({ builder: true, swap: false })).toMatchFileSnapshot(SNAPSHOT);
  });

  it("are exactly what a keyless default connection gets", async () => {
    const toolsets = selectToolsets(undefined, { hasApiKey: false, swapToolsEnabled: true });
    await expect(await listedTools(toolsets)).toMatchFileSnapshot(SNAPSHOT);
  });

  it("never reach a swap-only connection", async () => {
    const client = await connect({ builder: false, swap: true });
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
    await client.close();
  });
});
