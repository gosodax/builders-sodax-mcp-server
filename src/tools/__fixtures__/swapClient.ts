/** In-process MCP clients, on a swap-only server unless a test picks the toolsets. Not built. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server.js";
import type { ToolSelection } from "../../services/profiles.js";
import { initSodax } from "../../services/sodax.js";
import type { SwapQuote } from "../../services/swap/quote.js";

export const swapClient = () => mcpClient({ builder: false, swap: true, bridge: false });
export const bridgeClient = () => mcpClient({ builder: false, swap: false, bridge: true });

export async function mcpClient(toolsets: ToolSelection): Promise<Client> {
  // The swap and bridge tools need the SDK, which the server loads at boot.
  if (toolsets.swap || toolsets.bridge) await initSodax();
  const server = await createServer(toolsets);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Any quote outcome's fields, so a test can assert on whichever one it expects. */
export type QuoteOut = Partial<Extract<SwapQuote, { status: "ready" }>> &
  Partial<Extract<SwapQuote, { status: "price" }>> & {
    nextStep: string;
    error: { code: string } & Record<string, unknown>;
  };

/** Any outcome's fields, so a test can assert on whichever one it expects. */
export type ToolOut = Record<string, unknown> & {
  status: string;
  nextStep: string;
  error: { code: string } & Record<string, unknown>;
};

/** Calls a swap tool on a fresh connection and closes it. */
export async function callTool<Out = ToolOut>(name: string, args: Record<string, unknown>) {
  const client = await swapClient();
  // Listed first, so the client checks every result, errors included, against the tool's output schema.
  await client.listTools();
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return { isError: result.isError, out: result.structuredContent as Out };
}

// Only sodax_swap_prepare takes these; a call with any of them goes there, any other to sodax_swap_price.
const PREPARE_ONLY = ["fromAddress", "toAddress", "slippageBps", "deadlineMinutes"];

/** A swap priced, or prepared when given anything only preparing takes. */
export const callQuote = (args: Record<string, unknown>) =>
  callTool<QuoteOut>(PREPARE_ONLY.some(key => key in args) ? "sodax_swap_prepare" : "sodax_swap_price", args);
