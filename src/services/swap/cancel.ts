/**
 * `sodax_swap_cancel`, in two calls: the first returns the unsigned cancel for the user's wallet,
 * the second (with `cancelTxHash`) checks it on chain and relays it to the hub, because the cancel
 * endpoint only builds the tx. The intent comes from the hub, never from the agent.
 */

import { SODAX_HELP_DESK, sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import {
  cancelPayload,
  createIntentPayload,
  decodeAddress,
  intentChainId,
  intentHash,
  userHubWallet,
} from "../sodax.js";
import { ActionError } from "./errors.js";
import { type CachedQuote, claimDeposit, markHubOutcome } from "./quoteCache.js";
import {
  type NotCancellable,
  RETRY_AFTER_SEC,
  type SwapRef,
  committedPayload,
  intentClosed,
  isHubSource,
  readSourceTx,
  resolveSource,
  sourceTxHash,
  swapsIn,
  whyNotCancellable,
} from "./source.js";
import { holdsCancel } from "./sourceTx.js";
import type { CancelStep, SourceTx, SwapSource } from "./sources/types.js";
import { type Intent, getHubIntent, getSubmitTxStatus, relaySpokeTx } from "./swapsApi.js";
import { checkQuoteDeposit, deadlineMs, refundExpired, untilRefundSec } from "./track.js";

export type CancelState =
  | {
      status: "not_cancellable";
      /**
       * `closed`: the hub no longer holds the intent. `not_this_swap`: the tx didn't create the quote's intent.
       * `unverified`: without its quote, the tx's events can't all be read to tie the hub's intent to it.
       */
      reason: NotCancellable | "not_sent" | "closed" | "not_this_swap" | "unverified";
    }
  /** The quote's deposit is on chain, never submitted: from its deadline on, a cancel call refunds it. */
  | { status: "deposit_unsubmitted"; retryAfterSec: number }
  /** That refund's relay failed; the next call tries again. */
  | { status: "expired_unsubmitted"; alerted: boolean; retryAfterSec: number }
  | { status: "ready"; steps: [CancelStep] }
  /** `cancelTxHash`: the sent cancel, as its chain spells it. */
  | { status: "cancel_awaiting_confirmation"; retryAfterSec: number; cancelTxHash: string }
  | { status: "cancel_failed" }
  | { status: "not_a_cancel_tx" }
  /** `unverified`: its events couldn't be read, so only the relay checked that it's this swap's cancel. */
  | { status: "cancel_relayed"; cancelTxHash: string; unverified?: true }
  /** A swap from the hub: the cancel ran there, so nothing is relayed. */
  | { status: "cancel_confirmed" };

/** `cancelTxHash`: the cancel the call named, checked, on any result that came before it was read. */
export type CancelResult = SwapRef & { cancelTxHash?: string } & CancelState;

export async function cancelSwap(input: {
  txHash: string;
  quoteId?: string;
  chain?: string;
  cancelTxHash?: string;
}): Promise<CancelResult> {
  const source = await resolveSource(input);
  const txHash = sourceTxHash(source, input.txHash);
  const { quote } = source;
  const base: SwapRef = {
    txHash,
    chain: source.chain,
    ...(input.quoteId && { quoteId: input.quoteId }),
    ...(quote && { intentHash: intentHash(quote.intent) }),
  };
  // The caller mixed up two swaps: this quote's deposit is another tx.
  if (quote?.depositTxHash !== undefined && quote.depositTxHash !== txHash) {
    throw quoteMismatch("That quote was used by another transaction.");
  }
  // Its cancel was confirmed here already. One found closed is read again: it may be the user's own cancel.
  if (quote?.handedOver === "cancelled") return { ...base, status: "not_cancellable", reason: "cancelled" };

  const cancelTxHash = input.cancelTxHash && sourceTxHash(source, input.cancelTxHash, "cancelTxHash");

  // The swap first: a sent cancel is only worth waiting for if there's something to cancel.
  const row = await getSubmitTxStatus(txHash, source.chain.key);
  // A deposit this server relayed for refund has no backend row; its quote is the record.
  if (!row && quote?.handedOver === "relayed_for_refund" && quote.depositTxHash === txHash) {
    return { ...base, status: "not_cancellable", reason: "refunding" };
  }
  const reason = whyNotCancellable(row);
  const ended = reason === "solved" || reason === "cancelled" || reason === "refunding";
  // A swap from the hub is an intent there once mined: its quote's intent is cancelled, whatever the backend has.
  if (quote && isHubSource(source) && !ended) {
    const fromQuote = await hubCancel(base, source, quote, cancelTxHash);
    if (fromQuote) return fromQuote;
  } else if (!row && quote && !quote.handedOver) {
    const unsubmitted = await unsubmittedDeposit(base, source, quote);
    if (unsubmitted) return unsubmitted;
  }
  const hubTxHash = row?.result?.dstIntentTxHash;
  if (reason || !hubTxHash) {
    return {
      ...base,
      ...(cancelTxHash && { cancelTxHash }),
      status: "not_cancellable",
      reason: reason ?? "not_on_hub_yet",
    };
  }
  // Only a deposit track checked is the quote's: any other tx's intent says nothing about it.
  if (quote && quote.depositTxHash !== txHash) {
    throw quoteMismatch("That quote has no checked deposit in this transaction.");
  }

  const receipt = cancelTxHash ? await sentCancel(base, source, cancelTxHash, quote?.srcAddress) : undefined;
  if (receipt && "status" in receipt) return receipt;

  const intent = await getHubIntent(hubTxHash);
  const differs = quote ? differingFields(quote.intent, intent) : [];
  if (differs.length > 0) {
    logger.error(
      { "chain.key": source.chain.key, "quote.id": quote?.quoteId, fields: differs },
      "The hub intent isn't the quoted one",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service returned a different intent than the one quoted.", {
      details: { chainKey: source.chain.key },
    });
  }
  const deposits = quote ? "match" : await depositsIntent(source, txHash, intent);
  if (deposits === "unverified") return { ...base, status: "not_cancellable", reason: "unverified" };
  if (deposits === "mismatch") {
    logger.error({ "chain.key": source.chain.key }, "The hub intent isn't the tracked deposit's");
    throw new ActionError("SWAP_MISMATCH", "The swap service returned an intent that isn't this deposit's.", {
      details: { chainKey: source.chain.key },
    });
  }
  if (!receipt || !cancelTxHash) return readyCancel(base, source, intent, hubTxHash, quote);
  if (receipt.kind === "hub") return hubCancelled(base, source, intent, hubTxHash, receipt, cancelTxHash, quote);
  // The payload the sent cancel must carry, built here: a Swaps API outage can't hold up a mined cancel.
  const payload = cancelPayload(intent);
  if (!payload)
    throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.", { retryable: false });
  // The user's own message to their hub wallet, as the relay will read it: only that cancels the intent.
  const cancel = {
    srcAddress: intent.srcAddress,
    srcChain: intent.srcChain,
    creator: intent.creator,
    payload: committedPayload(source, payload),
  };
  // Events this server can't read aren't proof either way: the relay checks the message itself.
  if (!receipt.unreadable && !holdsCancel(receipt.messages, cancel)) return { ...base, status: "not_a_cancel_tx" };
  const data = source.adapter.commitsHash ? { address: intent.creator, payload } : undefined;
  if (!(await relaySpokeTx(intent.srcChain, cancelTxHash, data))) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX relay didn't take the cancel.");
  }
  return {
    ...base,
    status: "cancel_relayed",
    cancelTxHash,
    ...(receipt.unreadable && { unverified: true as const }),
  };
}

/**
 * A quote's tx with no backend row: nothing reached the hub to cancel. Its deposit stays on chain unswapped;
 * only track would submit it, and from its deadline on it's refunded as track does. `undefined`
 * for a mined tx that isn't this quote's deposit, which track reports on.
 */
async function unsubmittedDeposit(
  base: SwapRef,
  source: SwapSource,
  quote: CachedQuote,
): Promise<CancelResult | undefined> {
  // A checked deposit isn't read again: a node that has dropped it can't hold up its refund.
  const claimed = quote.depositTxHash === base.txHash;
  if (!claimed) {
    const swap = await checkSwapTx(base, source, quote);
    if (swap !== "match") return swap;
  }
  if (Date.now() < deadlineMs(quote)) {
    return { ...base, status: "deposit_unsubmitted", retryAfterSec: untilRefundSec(quote) };
  }
  if (!claimed && claimDeposit(quote.quoteId, base.txHash) !== "claimed") return undefined;
  const refund = await refundExpired(base, quote, source);
  return refund.status === "expired_unsubmitted" ? refund : { ...base, status: "not_cancellable", reason: "refunding" };
}

/**
 * A quoted swap from the hub: cancelled straight from the quote's intent once its tx logged that intent, before or
 * after its deadline, with or without a backend row, and confirmed by the intents contract's log of the cancel.
 * Claimed first, so this tx stays the quote's. `undefined` for a tx that created more than this intent, which track
 * reports on.
 */
async function hubCancel(
  base: SwapRef,
  source: SwapSource,
  quote: CachedQuote,
  cancelTxHash?: string,
): Promise<CancelResult | undefined> {
  // As for a spoke's deposit: one already checked isn't read again.
  if (quote.depositTxHash !== base.txHash) {
    const swap = await checkSwapTx(base, source, quote);
    if (swap !== "match") return swap;
    if (claimDeposit(quote.quoteId, base.txHash) === "taken") {
      throw quoteMismatch("That quote was used by another transaction.");
    }
  }
  // A swap from the hub created its intent itself.
  if (!cancelTxHash) return readyCancel(base, source, quote.intent, base.txHash, quote);
  const receipt = await sentCancel(base, source, cancelTxHash, quote.srcAddress);
  return "status" in receipt
    ? receipt
    : hubCancelled(base, source, quote.intent, base.txHash, receipt, cancelTxHash, quote);
}

/**
 * Whether the tx is the quote's swap, on chain: `match`; the answer for one never sent or holding no swap (an
 * approval, say); or `undefined` for one track reports on. Only an absence its node can vouch for, or a failed tx
 * with no deposit kept, is a swap never sent: no node drops a tx before its quote's deadline, and until then track
 * would submit it once it lands.
 */
async function checkSwapTx(
  base: SwapRef,
  source: SwapSource,
  quote: CachedQuote,
): Promise<"match" | CancelResult | undefined> {
  const receipt = await readSourceTx(source, base.txHash, quote.srcAddress);
  const notSent: CancelResult = { ...base, status: "not_cancellable", reason: "not_sent" };
  if (!receipt) return source.adapter.prunes && Date.now() >= deadlineMs(quote) ? undefined : notSent;
  if (receipt.failed) return swapsIn(source, receipt) > 0 ? undefined : notSent;
  if (receipt.kind === "spoke" && receipt.unreadable) return undefined;
  const check = checkQuoteDeposit(source, receipt, quote);
  if (check === "not_a_deposit") return { ...base, status: "not_cancellable", reason: "not_this_swap" };
  return check === "match" ? "match" : undefined;
}

/**
 * The cancel for the user's wallet, while the hub holds the intent: once it's filled or cancelled, one fails. From
 * the hub (the wallet router runs the call) and from a non-EVM spoke the SDK builds it, as its own clients do; from
 * an EVM spoke the backend does, and the build is checked before anyone signs it.
 */
async function readyCancel(
  base: SwapRef,
  source: SwapSource,
  intent: Intent,
  createdIn: string,
  quote?: CachedQuote,
): Promise<CancelResult> {
  const hash = intentHash(intent);
  if (await intentClosed(hash, createdIn)) {
    // Track then reports a quoted hub swap closed, not waiting for a refund.
    if (quote && isHubSource(source)) markHubOutcome(quote, "closed");
    return { ...base, intentHash: hash, status: "not_cancellable", reason: "closed" };
  }
  return { ...base, status: "ready", steps: [await source.adapter.cancelStep(source, intent)] };
}

/** A sent cancel as its chain proves it, or the answer while it hasn't run or if it failed. */
async function sentCancel(
  base: SwapRef,
  source: SwapSource,
  cancelTxHash: string,
  sender?: string,
): Promise<SourceTx | CancelResult> {
  const receipt = await readSourceTx(source, cancelTxHash, sender);
  if (receipt === null) {
    return { ...base, status: "cancel_awaiting_confirmation", retryAfterSec: RETRY_AFTER_SEC, cancelTxHash };
  }
  // A failed cancel is a new one to send, whether or not its events could be read.
  if (receipt.failed || (receipt.kind === "spoke" && receipt.unreadable?.failed)) {
    return { ...base, status: "cancel_failed" };
  }
  return receipt;
}

/**
 * A cancel on the hub is confirmed by the intents contract's log of it, mined after `createdIn` (the hub tx that
 * created the intent); the quote remembers, as no row may.
 */
async function hubCancelled(
  base: SwapRef,
  source: SwapSource,
  intent: Intent,
  createdIn: string,
  receipt: SourceTx,
  cancelTxHash: string,
  quote?: CachedQuote,
): Promise<CancelResult> {
  const hash = intentHash(intent);
  if (receipt.kind !== "hub" || !receipt.cancelled.some(logged => same(logged, hash))) {
    return { ...base, status: "not_a_cancel_tx" };
  }
  // The hub deletes a cancelled intent, so the same one may be created again: an earlier cancel isn't this one's.
  const created = await readSourceTx(source, createdIn);
  if (!created) {
    return { ...base, status: "cancel_awaiting_confirmation", retryAfterSec: RETRY_AFTER_SEC, cancelTxHash };
  }
  if (created.kind !== "hub" || !minedAfter(receipt, created)) return { ...base, status: "not_a_cancel_tx" };
  if (quote) markHubOutcome(quote, "cancelled");
  return { ...base, status: "cancel_confirmed" };
}

type Mined = { blockNumber: bigint; txIndex: number };
const minedAfter = (later: Mined, earlier: Mined) =>
  later.blockNumber > earlier.blockNumber ||
  (later.blockNumber === earlier.blockNumber && later.txIndex > earlier.txIndex);

const quoteMismatch = (message: string) =>
  new ActionError("QUOTE_MISMATCH", message, {
    nextStep: "Call again with the quoteId this transaction was made from, or with chain instead of quoteId.",
    details: { field: "quoteId" },
  });

/**
 * Without a quote, the hub intent must be the tracked swap's: from this chain, and alone in that tx, either a
 * deposit by the intent's source address to its creator with the calls that create this very intent, or on the
 * hub the intents contract's log of it. The creator must be that address's hub wallet, so its cancel reaches it.
 * `unverified` for a tx whose events can't all be read.
 */
async function depositsIntent(
  source: SwapSource,
  txHash: string,
  intent: Intent,
): Promise<"match" | "mismatch" | "unverified"> {
  if (intent.srcChain !== intentChainId(source.chain.key)) return "mismatch";
  // A deposit must carry the calls that create this intent; a hub swap is matched by the intent's hash alone.
  const payload = isHubSource(source) ? "" : createIntentPayload(intent);
  // The SDK takes the sender as its chain spells it; the intent holds it encoded.
  const sender = decodeAddress(source.chain.key, intent.srcAddress);
  if (payload === undefined || sender === undefined) return "mismatch";
  const receipt = await readSourceTx(source, txHash, sender);
  if (!receipt) {
    const { name } = source.chain;
    // The deposit reached the hub, so it's mined: an EVM node without its receipt is behind, while a public non-EVM
    // node drops older txs for good, and calling again won't help.
    if (!source.adapter.prunes) throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't read ${name} right now.`);
    throw new ActionError("QUOTE_NOT_FOUND", `Without its quote, this server can't check this swap on ${name}.`, {
      nextStep: `${name}'s node no longer has the swap's transaction. Call sodax_swap_cancel again with its quoteId if the user has it; if not, tell the user this server can't cancel it, that it is safe on the SODAX hub, and to give its transaction hash to ${SODAX_HELP_DESK}.`,
      details: { field: "quoteId" },
    });
  }
  // Events it can't read prove nothing either way: not an upstream mismatch.
  if (receipt.kind === "spoke" && receipt.unreadable) return "unverified";
  // As track checks a quote's: alone in its tx.
  const swap = { intent, relayData: { address: intent.creator, payload } };
  if (checkQuoteDeposit(source, receipt, swap) !== "match") return "mismatch";
  const hubWallet = await userHubWallet(source.chain.key, sender).catch(() => {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "Couldn't look up the user's SODAX hub wallet.");
  });
  return same(hubWallet, intent.creator) ? "match" : "mismatch";
}

/** The intent fields that differ; hex in any case is the same value. */
function differingFields(quoted: Intent, hub: Intent): (keyof Intent)[] {
  return (Object.keys(quoted) as (keyof Intent)[]).filter(field => !same(String(quoted[field]), String(hub[field])));
}
