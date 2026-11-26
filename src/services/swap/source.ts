/**
 * Where a swap started and what's known about it, shared by quote, track and cancel: which chains
 * a swap can start from, the caller's quote, and whether a submitted swap can be cancelled. Also
 * the one way to read a chain (`chainRead`), which the balance tool uses too.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";
import { holdForTrack } from "../signWindow.js";
import { hubIntentClosed } from "../sodax.js";
import { type ChainInfo, resolveChainKey } from "../sodaxApi.js";
import { ActionError, type Product, nextStepOf } from "./errors.js";
import { getCachedQuote } from "./quoteCache.js";
import { chainOptions, isSwapSource, resolveSwapChain, swapChains, toChain } from "./resolver.js";
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
export function sourceTxHash(source: SwapSource, value: string, product: Product, field = "txHash"): string {
  const { format, spell } = source.adapter.txHash;
  const txHash = spell(value.trim());
  if (txHash === undefined) {
    const refusal = (nextStep?: string) =>
      new ActionError("INVALID_TX_HASH", `That isn't a transaction hash on ${source.chain.name}.`, {
        nextStep,
        details: { field, format },
      });
    // A batch id is EVM's: a wallet that sent a batch reports both.
    throw source.adapter.family === "EVM"
      ? refusal(
          `${nextStepOf(refusal(), product)} From a batch, it's the transaction hash wallet_getCallsStatus reports, not the batch id.`,
        )
      : refusal();
  }
  return txHash;
}

/**
 * A chain a swap can start from (`pinnedSourceOf`), of the family the live catalog says. Pinned from the SDK
 * config, so a deposit already sent is checked whatever the live config says; the quote refuses a live chain id
 * that disagrees.
 */
export function sourceChainFor(catalog: SwapCatalog, chain: ChainInfo, sent = false): SourceChain {
  const source = pinnedSourceOf(chain.key);
  if (!source || !isSwapSource(catalog, chain.key))
    throw unsupportedSource(chain, catalog.product, swapChains(catalog, true), sent);
  return source;
}

/**
 * Names the chains a swap can start from, so the agent needn't try each: a quote asks the user to pick
 * one, a swap already sent was sent from one of them. Without the live catalog, the SDK config's.
 */
function unsupportedSource(
  chain: ChainInfo,
  product: Product,
  sources: ChainInfo[] = sourceChainKeys().map(toChain),
  sent = false,
): ActionError {
  const names = sources.map(({ name }) => name).join(", ");
  const nextStep = sent
    ? `No ${product} can start from ${chain.name}: ask the user which chain they sent the ${product} from${names && ` (one of ${names})`} and pass its key.`
    : names && `A ${product} can start only from ${names}: ask the user to ${product} from one of them.`;
  const field = sent ? "chain" : "fromChain";
  const plural = product === "bridge" ? "Bridges" : "Swaps";
  return new ActionError("UNSUPPORTED_SOURCE", `${plural} from ${chain.name} aren't supported here.`, {
    nextStep: nextStep || undefined,
    details: { field, ...(sources.length > 0 && { sourceChains: sources }) },
    hint: { options: chainOptions(sources, field) },
  });
}

/** The source from the SDK config alone: a quoted chain stays trackable after the live catalog drops it. */
function pinnedSource(chain: ChainInfo): SourceChain {
  const source = pinnedSourceOf(chain.key);
  if (!source) throw unsupportedSource(chain, "swap", undefined, true);
  return source;
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
 * The swap a track or cancel call names: its source and its tx hash, spelled once as the chain does (the backend keys
 * rows on the exact string). A hash the chain can have holds the quote (`holdForTrack`); a malformed one holds nothing.
 */
export async function resolveSentTx(input: {
  txHash: string;
  quoteId?: string;
  chain?: string;
}): Promise<{ source: SwapSource; txHash: string }> {
  const source = await resolveSource(input);
  const txHash = sourceTxHash(source, input.txHash, "swap");
  if (source.quote) holdForTrack(source.quote);
  return { source, txHash };
}

/**
 * The source from the caller's quote, or from `chain` without one. Quotes are bound to their creator's key.
 * A quote's source comes from the SDK config, not the live catalog: its deposit may already be on chain.
 */
async function resolveSource(input: { quoteId?: string; chain?: string }): Promise<SwapSource> {
  const cached = input.quoteId ? getCachedQuote(input.quoteId, callerKeyHash()) : undefined;
  if (cached === "key_mismatch") {
    throw new ActionError("QUOTE_KEY_MISMATCH", "That quote was made with another SODAX API key.");
  }
  if (cached) {
    const chain = toChain(cached.srcChainKey);
    if (input.chain && !namesChain(input.chain, chain.key)) {
      throw new ActionError("QUOTE_MISMATCH", "That quote is for another source chain.", {
        details: { field: "quoteId" },
      });
    }
    return { chain, ...pinnedSource(chain), quote: cached };
  }
  if (!input.chain) {
    if (!input.quoteId) {
      throw new ActionError("QUOTE_NOT_FOUND", "Pass the quoteId or the source chain.", {
        details: { field: "chain" },
      });
    }
    // With the chain the tx is still checked, and a stranded deposit reported.
    throw new ActionError("QUOTE_NOT_FOUND", "That quote has expired, or was lost when this server restarted.", {
      nextStep: "Call again with the same arguments plus chain set to the swap's source chain key.",
      details: { field: "chain" },
    });
  }
  const catalog = await getSwapCatalog();
  const chain = resolveSwapChain(catalog, input.chain, true);
  return { chain, ...sourceChainFor(catalog, chain, true) };
}

/** Whether `query` names the chain `chainKey`, as a name, ticker, key or EVM chain id, without the catalog. */
function namesChain(query: string, chainKey: string): boolean {
  return resolveChainKey(query, [chainKey]).key === chainKey;
}

/** The source tx once it ran, as what it proves (`SourceTx`), or `null` before. `sender` routes a NEAR lookup. */
export function readSourceTx(source: SwapSource, txHash: string, sender?: string): Promise<SourceTx | null> {
  return chainRead(source.chain, () => source.adapter.read(source, txHash, sender));
}

/** Whether the chain's node knows the tx at all, mined or pending; `undefined` where its nodes can't say. */
export async function seenOnChain(source: SwapSource, txHash: string, sender?: string): Promise<boolean | undefined> {
  const { seen } = source.adapter;
  return seen && chainRead(source.chain, () => seen(source, txHash, sender));
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
 * Whether the hub is known to no longer hold the intent `createdIn` (a hub tx) created: filled or cancelled. Only a
 * guard against a pointless cancel or submit, so a failed read (logged as a chain read) answers `false`, as before it.
 */
export function intentClosed(hash: string, createdIn: string): Promise<boolean> {
  return hubIntentClosed(hash, createdIn).catch(() => false);
}

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
