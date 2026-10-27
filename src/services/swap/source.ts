/**
 * Where a swap started and what's known about it, shared by quote, track and cancel: which chains
 * a swap can start from, the caller's quote, chain reads, and whether a submitted swap can be
 * cancelled.
 */

import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";
import { type EvmReceipt, connectionFor, evmChainIdFor, getEvmReceipt, isTxKnown, swapContractFor } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { ActionError } from "./errors.js";
import { type CachedQuote, getCachedQuote } from "./quoteCache.js";
import { resolveSwapChain, toChain } from "./resolver.js";
import type { SubmitTxStatus } from "./swapsApi.js";
import { type SwapCatalog, getSwapCatalog } from "./tokens.js";

export const RETRY_AFTER_SEC = 15;

/** The swap a track or cancel call is about. */
export type SwapRef = { txHash: string; chain: ChainInfo; quoteId?: string };

/** What checking a source tx needs. */
export interface SourceChain {
  /** The EVM chain id, for the steps a wallet sends. */
  chainId: number;
  connection: string;
  assetManager: string;
}

export type SwapSource = SourceChain & { chain: ChainInfo; quote?: CachedQuote };

/**
 * A chain a swap can start from: an EVM spoke whose `connection` log proves the deposit. The hub
 * has none, so nothing could prove or submit a swap from it yet. All three are pinned from the SDK
 * config, so a deposit already sent is checked whatever the live config says; the quote refuses a
 * live chain id that disagrees.
 */
export function sourceChainFor(catalog: SwapCatalog, chain: ChainInfo): SourceChain {
  const live = catalog.chains[chain.key];
  const chainId = evmChainIdFor(chain.key);
  const connection = connectionFor(chain.key);
  const assetManager = swapContractFor(chain.key);
  if (live?.type !== "EVM" || chainId === undefined || !connection || !assetManager) {
    throw new ActionError("UNSUPPORTED_SOURCE", `Swaps from ${chain.name} aren't supported here yet.`);
  }
  return { chainId, connection, assetManager };
}

/** The live config disagrees with the SDK's packaged one: a broken or compromised upstream. */
export function configDisagrees(chainKey: string, field: string, token?: string): ActionError {
  logger.error({ chainKey, field, token }, "The live SODAX config differs from the SDK's");
  return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX config doesn't agree with the SDK's.");
}

/** The source from the caller's quote, or from `chain` without one. Quotes are bound to their creator's key. */
export async function resolveSource(input: { quoteId?: string; chain?: string }): Promise<SwapSource> {
  const cached = input.quoteId ? getCachedQuote(input.quoteId, callerKeyHash()) : undefined;
  if (cached === "key_mismatch") {
    throw new ActionError("QUOTE_KEY_MISMATCH", "That quote was made with another SODAX API key.");
  }
  const catalog = await getSwapCatalog();
  let chain = cached && toChain(cached.srcChainKey);
  if (input.chain) {
    const named = resolveSwapChain(catalog, input.chain);
    if (chain && named.key !== chain.key) {
      throw new ActionError("QUOTE_MISMATCH", "That quote is for another source chain.");
    }
    chain = named;
  }
  if (!chain) {
    if (!input.quoteId) throw new ActionError("QUOTE_NOT_FOUND", "Pass the quoteId or the source chain.");
    // With the chain the tx is still checked, and a stranded deposit reported.
    throw new ActionError("QUOTE_NOT_FOUND", "That quote has expired or isn't known here.", {
      nextStep: "Call again with the same arguments plus chain set to the swap's source chain key.",
    });
  }
  return { chain, ...sourceChainFor(catalog, chain), ...(cached && { quote: cached }) };
}

/** The receipt, or `null` while the tx isn't mined. */
export function readReceipt(chain: ChainInfo, txHash: string): Promise<EvmReceipt | null> {
  return chainRead(chain, "receipt", () => getEvmReceipt(chain.key, txHash));
}

/** Whether the chain's node knows the tx at all, mined or pending. */
export function seenOnChain(chain: ChainInfo, txHash: string): Promise<boolean> {
  return chainRead(chain, "transaction", () => isTxKnown(chain.key, txHash));
}

/** A failed read is `CHAIN_UNAVAILABLE`, carrying no RPC text. */
async function chainRead<T>(chain: ChainInfo, op: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    logger.warn({ chainKey: chain.key, op }, "Chain read failed");
    throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't read ${chain.name} right now.`);
  }
}

export type NotCancellable = "not_submitted" | "solved" | "cancelled" | "refunding" | "not_on_hub_yet";

/**
 * Why a submitted swap can't be cancelled, or `undefined` if it can: only an intent on the hub that
 * isn't solved, cancelled or being refunded. A cancel and a fill exclude each other on chain.
 */
export function whyNotCancellable(row: SubmitTxStatus | null): NotCancellable | undefined {
  if (!row) return "not_submitted";
  if (row.status === "solved") return "solved";
  if (row.intentCancelled) return "cancelled";
  if (row.relayedForRefundAt) return "refunding";
  return row.result?.dstIntentTxHash ? undefined : "not_on_hub_yet";
}
