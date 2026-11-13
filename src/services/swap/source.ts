/**
 * Where a swap started and what's known about it, shared by quote, track and cancel: which chains
 * a swap can start from, the caller's quote, and whether a submitted swap can be cancelled. Also
 * the one way to read a chain (`chainRead`), which the balance tool uses too.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";
import { evmChainIdFor } from "../sodax.js";
import { type ChainInfo, resolveChainKey } from "../sodaxApi.js";
import { ActionError } from "./errors.js";
import { getCachedQuote } from "./quoteCache.js";
import { chainIdQuery, isSwapSource, resolveSwapChain, toChain } from "./resolver.js";
import { depositMessages } from "./sourceTx.js";
import { hexBytes } from "./sources/bytes.js";
import { pinnedSourceOf, sourceChainKeys } from "./sources/index.js";
import type { SourceChain, SourceTx, SwapSource } from "./sources/types.js";
import type { SubmitTxStatus } from "./swapsApi.js";
import { type SwapCatalog, getSwapCatalog } from "./tokens.js";

export const RETRY_AFTER_SEC = 15;

/** The swap a track or cancel call is about. */
export type SwapRef = { txHash: string; chain: ChainInfo; quoteId?: string; intentHash?: string };

/** The hub: its swap tx creates the intent itself, so nothing is relayed and an unsubmitted intent is refunded. */
export const isHubSource = (source: SourceChain) => source.kind === "hub";

/** A tx hash as the source chain spells it; one that can't be its chain's is refused before anything is read. */
export function sourceTxHash(source: SwapSource, value: string, field = "txHash"): string {
  const { format, spell } = source.adapter.txHash;
  const txHash = spell(value.trim());
  if (txHash === undefined) {
    throw new ActionError("INVALID_TX_HASH", `That isn't a transaction hash on ${source.chain.name}.`, {
      details: { field, format },
    });
  }
  return txHash;
}

/**
 * A chain a swap can start from (`pinnedSourceOf`), of the family the live catalog says. Pinned from the SDK
 * config, so a deposit already sent is checked whatever the live config says; the quote refuses a live chain id
 * that disagrees.
 */
export function sourceChainFor(catalog: SwapCatalog, chain: ChainInfo): SourceChain {
  const source = pinnedSourceOf(chain.key);
  if (!source || !isSwapSource(catalog, chain.key)) throw unsupportedSource(chain, catalog);
  return source;
}

/** The source from the SDK config alone: a quoted chain stays trackable after the live catalog drops it. */
function pinnedSource(chain: ChainInfo): SourceChain {
  const source = pinnedSourceOf(chain.key);
  if (!source) throw unsupportedSource(chain);
  return source;
}

// The chains named in the error, as UNSUPPORTED_CHAIN names them: the swap profile has no chain support tool to ask.
const unsupportedSource = (chain: ChainInfo, catalog?: SwapCatalog) => {
  const keys = catalog ? Object.keys(catalog.tokens).filter(key => isSwapSource(catalog, key)) : sourceChainKeys();
  return new ActionError("UNSUPPORTED_SOURCE", `Swaps from ${chain.name} aren't supported here.`, {
    details: { sourceChains: keys.map(toChain) },
  });
};

/** The live config disagrees with the SDK's packaged one: a broken or compromised upstream. */
export function configDisagrees(chainKey: string, field: string, token?: string): ActionError {
  logger.error(
    { "chain.key": chainKey, field, "token.address": token },
    "The live SODAX config differs from the SDK's",
  );
  return new ActionError("SWAP_MISMATCH", "The SODAX config doesn't agree with the SDK's.", { details: { chainKey } });
}

/**
 * The source from the caller's quote, or from `chain` without one. Quotes are bound to their creator's key.
 * A quote's source comes from the SDK config, not the live catalog: its deposit may already be on chain.
 */
export async function resolveSource(input: { quoteId?: string; chain?: string }): Promise<SwapSource> {
  const cached = input.quoteId ? getCachedQuote(input.quoteId, callerKeyHash()) : undefined;
  if (cached === "key_mismatch") {
    throw new ActionError("QUOTE_KEY_MISMATCH", "That quote was made with another SODAX API key.");
  }
  if (cached) {
    const chain = toChain(cached.srcChainKey);
    if (input.chain && !namesChain(input.chain, chain.key)) {
      throw new ActionError("QUOTE_MISMATCH", "That quote is for another source chain.");
    }
    return { chain, ...pinnedSource(chain), quote: cached };
  }
  if (!input.chain) {
    if (!input.quoteId) throw new ActionError("QUOTE_NOT_FOUND", "Pass the quoteId or the source chain.");
    // With the chain the tx is still checked, and a stranded deposit reported.
    throw new ActionError("QUOTE_NOT_FOUND", "That quote has expired, or was lost when this server restarted.", {
      nextStep: "Call again with the same arguments plus chain set to the swap's source chain key.",
    });
  }
  const catalog = await getSwapCatalog();
  const chain = resolveSwapChain(catalog, input.chain, true);
  return { chain, ...sourceChainFor(catalog, chain) };
}

/** Whether `query` names the chain `chainKey`, as a name, ticker, key or EVM chain id, without the catalog. */
function namesChain(query: string, chainKey: string): boolean {
  if (resolveChainKey(query, [chainKey]).key === chainKey) return true;
  const id = chainIdQuery(query);
  return id !== undefined && id === evmChainIdFor(chainKey);
}

/** The source tx once it ran, as what it proves (`SourceTx`), or `null` before. `sender` routes a NEAR lookup. */
export function readSourceTx(source: SwapSource, txHash: string, sender?: string): Promise<SourceTx | null> {
  return chainRead(source.chain, () => source.adapter.read(source, txHash, sender));
}

/** Whether the chain's node knows the tx at all, mined or pending; a node that can't say answers false. */
export function seenOnChain(source: SwapSource, txHash: string): Promise<boolean> {
  return chainRead(source.chain, () => source.adapter.seen(source, txHash));
}

/** How many swaps the tx sends: intents created on the hub, or deposits from a spoke, whichever quote they're for. */
export function swapsIn(source: SourceChain, sourceTx: SourceTx): number {
  if (sourceTx.kind === "hub") return sourceTx.created.length;
  return source.kind === "spoke" ? depositMessages(sourceTx.messages, source.depositor).length : 0;
}

/**
 * A relay payload as a spoke's message carries it: from Solana only its keccak, so the relay takes the payload with
 * the tx and checks it against that.
 */
export function committedPayload(source: SourceChain, payload: string): string {
  if (!source.adapter.commitsHash) return payload;
  return `0x${Buffer.from(keccak_256(hexBytes(payload))).toString("hex")}`;
}

/** What a spoke's deposit of the swap must say (`checkDeposit`): its asset manager, source, sender, recipient, payload. */
export function depositTerms(
  source: SourceChain,
  swap: { intent: { srcChain: string; srcAddress: string }; relayData: { address: string; payload: string } },
) {
  return {
    assetManager: source.kind === "spoke" ? source.depositor : "",
    srcChain: swap.intent.srcChain,
    srcAddress: swap.intent.srcAddress,
    to: swap.relayData.address,
    data: committedPayload(source, swap.relayData.payload),
  };
}

/** A failed read is `CHAIN_UNAVAILABLE`, carrying no RPC text. Its record is the read's own ("Chain read", sodax.ts). */
export async function chainRead<T>(chain: ChainInfo, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
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
