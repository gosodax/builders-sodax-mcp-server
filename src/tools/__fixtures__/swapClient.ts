/** An in-process MCP client on a swap-only server. Not built. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server.js";
import type { SwapQuote } from "../../services/swap/quote.js";

export async function swapClient(): Promise<Client> {
  const server = await createServer({ builder: false, swap: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Any quote outcome's fields, so a test can assert on whichever one it expects. */
export type QuoteOut = Partial<Extract<SwapQuote, { status: "ready" }>> &
  Partial<Extract<SwapQuote, { status: "price_only" }>> & {
    nextStep: string;
    error: { code: string } & Record<string, unknown>;
  };

/** Calls sodax_swap_quote on a fresh connection and closes it. */
export async function callQuote(args: Record<string, unknown>) {
  const client = await swapClient();
  const result = await client.callTool({ name: "sodax_swap_quote", arguments: args });
  await client.close();
  return { isError: result.isError, out: result.structuredContent as QuoteOut };
}
