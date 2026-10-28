/**
 * Shared setup for the track and cancel tests: a cached quote for the recorded Arbitrum deposit,
 * receipts built around it, and a stubbed Swaps API that records its calls. Not built.
 */

import { vi } from "vitest";
import { SODAX_SWAPS_BASE_URL } from "../../constants.js";
import { callerKeyHash } from "../../services/requestContext.js";
import type { EvmReceipt } from "../../services/sodax.js";
import { catalogFetch } from "../../services/swap/__fixtures__/catalog.js";
import {
  CREATOR,
  DEPOSIT_RELAY_DATA,
  DEPOSIT_TX,
  USER,
  messageReceipt,
} from "../../services/swap/__fixtures__/deposit.js";
import { type CachedQuote, putQuote } from "../../services/swap/quoteCache.js";
import { swapClient } from "./swapClient.js";

export const NOW = Date.parse("2026-10-26T12:00:00Z");
export const DEADLINE = String(NOW / 1000 + 15 * 60);
export { CONNECTION, CREATOR, DEPOSIT_RECEIPT, USER } from "../../services/swap/__fixtures__/deposit.js";
export const ARBITRUM = "0xa4b1.arbitrum";
export const TX = DEPOSIT_TX;

export const INTENT = {
  intentId: "7",
  creator: CREATOR,
  inputToken: "0xdB7BdA65c3a1C51D64dC4444e418684677334109",
  outputToken: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
  inputAmount: "5000000",
  minOutputAmount: "4941968",
  deadline: DEADLINE,
  allowPartialFill: false,
  srcChain: "23",
  dstChain: "146",
  srcAddress: USER,
  dstAddress: USER,
  solver: `0x${"0".repeat(40)}`,
  data: "0x",
};

/** A quote for the recorded deposit, made by the current caller unless `keyHash` says otherwise. */
export function cacheQuote(overrides: Partial<CachedQuote> = {}): CachedQuote {
  return putQuote({
    srcChainKey: ARBITRUM,
    dstChainKey: "sonic",
    srcAddress: USER,
    dstAddress: USER,
    inputToken: "0x0000000000000000000000000000000000000000",
    outputToken: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    inputAmount: 5000000n,
    minOutputAmount: 4941968n,
    deadline: DEADLINE,
    intent: INTENT,
    relayData: DEPOSIT_RELAY_DATA,
    keyHash: callerKeyHash(),
    minimumReceived: { amount: "4.941968", symbol: "USDC", chainName: "Sonic" },
    ...overrides,
  });
}

/** A receipt with one `connection` Message from the user to their hub wallet (a cancel). */
export function cancelReceipt(payload: string, from = USER): EvmReceipt {
  return messageReceipt({ srcAddress: from, dstAddress: CREATOR, payload });
}

export interface Backend {
  /** Replaces the recorded chain config. */
  configs?: string;
  /** The submit-tx row, or `null` for a 404; after a submit the stub reports `pending` unless set. */
  row?: Record<string, unknown> | null;
  status?: () => Response;
  submit?: () => Response;
  relay?: () => Response;
  hubIntent?: Record<string, unknown>;
  cancelTx?: Record<string, unknown>;
}

/** Serves the catalog and the Swaps API routes track and cancel use; records each Swaps API call. */
export function stubBackend(backend: Backend = {}) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let submitted = false;
  const serveCatalog = catalogFetch(undefined, backend.configs);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(`${SODAX_SWAPS_BASE_URL}/`) || url.endsWith("/tokens")) return serveCatalog(input, init);
    const path = url.slice(SODAX_SWAPS_BASE_URL.length);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.startsWith("/submit-tx/status?")) {
      if (backend.status) return backend.status();
      const row = backend.row !== undefined ? backend.row : submitted ? { status: "pending" } : null;
      return row
        ? Response.json({ success: true, data: { txHash: TX, srcChainKey: ARBITRUM, processingAttempts: 0, ...row } })
        : Response.json({ message: "Swap transaction not found" }, { status: 404 });
    }
    if (path === "/submit-tx") {
      submitted = true;
      return backend.submit?.() ?? Response.json({ success: true, data: { status: "inserted", message: "ok" } });
    }
    if (path === "/intents/submit")
      return backend.relay?.() ?? Response.json({ result: { success: true, message: "" } });
    if (path === "/intents/cancel") return Response.json({ tx: backend.cancelTx });
    if (path.startsWith("/intents/0x")) return Response.json(backend.hubIntent ?? INTENT);
    throw new Error(`unexpected Swaps API call ${path}`);
  });
  return calls;
}

/** Any outcome's fields, so a test can assert on whichever one it expects. */
export type ToolOut = Record<string, unknown> & {
  status: string;
  nextStep: string;
  error: { code: string } & Record<string, unknown>;
};

/** Calls a swap tool on a fresh connection and closes it. */
export async function callTool(name: string, args: Record<string, unknown>) {
  const client = await swapClient();
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return { isError: result.isError, out: result.structuredContent as ToolOut };
}
