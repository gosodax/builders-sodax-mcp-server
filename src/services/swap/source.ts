/**
 * Where a swap started and what's known about it, shared by quote, track and cancel: which chains
 * a swap can start from, the caller's quote, and whether a submitted swap can be cancelled. Also
 * the one way to read a chain (`chainRead`), which the balance tool uses too.
 */

import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";
import {
  type EvmReceipt,
  type NonEvmSourceType,
  blockNumber,
  callsPinnedTarget,
  evmChainIdFor,
  getEvmReceipt,
  isTxKnown,
  pinnedSourceOf,
  readNonEvmTx,
  sourceChainKeys,
} from "../sodax.js";
import { type ChainInfo, resolveChainKey } from "../sodaxApi.js";
import { ActionError } from "./errors.js";
import { type NonEvmTx, normalizeTxHash, txHashFormat } from "./nonEvmSource.js";
import { type CachedQuote, getCachedQuote } from "./quoteCache.js";
import { chainIdQuery, isSwapSource, resolveSwapChain, toChain } from "./resolver.js";
import type { SubmitTxStatus } from "./swapsApi.js";
import { type SwapCatalog, getSwapCatalog } from "./tokens.js";

export const RETRY_AFTER_SEC = 15;

/** The swap a track or cancel call is about. */
export type SwapRef = { txHash: string; chain: ChainInfo; quoteId?: string; intentHash?: string };

/** What checking a source tx needs: on an EVM chain (the hub included), or a non-EVM spoke. */
export type SourceChain = EvmSource | NonEvmSource;

export interface EvmSource {
  family: "EVM";
  /** The EVM chain id, for the steps a wallet sends. */
  chainId: number;
  /** What the swap tx calls: a spoke's asset manager, or the hub's intents contract. */
  swapContract: string;
  /** A spoke's `connection`, whose log proves a deposit. None on the hub: the swap tx itself creates the intent. */
  connection?: string;
}

/** A non-EVM spoke: its swap tx carries the quoted relay payload, which proves the deposit. */
export interface NonEvmSource {
  family: NonEvmSourceType;
  /** The asset manager, as the SDK config names it. */
  swapContract: string;
  /** How its tx names the asset manager (`assetManagerMarker`): track's proof of a deposit. */
  marker: Uint8Array | string;
}

export type SwapSource = SourceChain & { chain: ChainInfo; quote?: CachedQuote };

/** The hub: its swap tx creates the intent itself, so nothing is relayed and an unsubmitted intent is refunded. */
export const isHubSource = (source: SourceChain) => source.family === "EVM" && !source.connection;

/** A tx hash as the source chain spells it (`normalizeTxHash`); one that can't be its chain's is refused. */
export function sourceTxHash(source: SwapSource, value: string, field = "txHash"): string {
  const txHash = normalizeTxHash(source.family, value);
  if (txHash === undefined) {
    throw new ActionError("INVALID_TX_HASH", `That isn't a transaction hash on ${source.chain.name}.`, {
      details: { field, format: txHashFormat(source.family) },
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

/**
 * Refuses a non-EVM build to another program than the pinned one (`callsPinnedTarget`). The SDK reads Solana's
 * programs and Sui's package from the chain, so a wrong one is this server's RPC, not the Swaps API.
 */
export function checkPinnedTarget(chainKey: string, kind: "swap" | "cancel", raw: unknown, expected?: unknown): void {
  if (callsPinnedTarget(chainKey, kind, raw, expected)) return;
  logger.error({ "chain.key": chainKey }, `The SDK built a ${kind} to another program than expected`);
  throw new ActionError("SWAP_MISMATCH", `The ${kind} built here calls another program than expected.`, {
    details: { chainKey },
  });
}

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

/** A source tx that ran, with the source it was read from: an EVM receipt, or a non-EVM chain's tx. */
export type SourceTx =
  | { family: "EVM"; reverted: boolean; receipt: EvmReceipt; source: EvmSource }
  | { family: NonEvmSourceType; reverted: boolean; tx: NonEvmTx; source: NonEvmSource };

/**
 * The source tx once it ran, or `null` before. `sender` routes a NEAR lookup; any account does on public nodes.
 */
export async function readSourceTx(source: SwapSource, txHash: string, sender?: string): Promise<SourceTx | null> {
  const { chain } = source;
  if (source.family === "EVM") {
    const receipt = await chainRead(chain, () => getEvmReceipt(chain.key, txHash));
    return receipt && { family: "EVM", reverted: receipt.reverted, receipt, source };
  }
  const { family } = source;
  const tx = await chainRead(chain, () => readNonEvmTx(chain.key, family, txHash, sender));
  return tx && { family, reverted: tx.failed, tx, source };
}

/**
 * Whether the chain's node knows the tx at all, mined or pending. Only an EVM node says: a non-EVM tx is
 * reported unseen until it ran.
 */
export function seenOnChain(source: SwapSource, txHash: string): Promise<boolean> {
  const { chain } = source;
  if (source.family !== "EVM") return Promise.resolve(false);
  return chainRead(chain, () => isTxKnown(chain.key, txHash));
}

/** An EVM or NEAR chain's latest block: a ready quote reads it to check the RPC its track will need. */
export function readBlockNumber(chain: ChainInfo): Promise<bigint> {
  return chainRead(chain, () => blockNumber(chain.key));
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
