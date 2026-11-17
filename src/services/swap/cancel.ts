/**
 * `sodax_swap_cancel`, in two calls: the first returns the unsigned cancel for the user's wallet,
 * the second (with `cancelTxHash`) checks it on chain and relays it to the hub, because the cancel
 * endpoint only builds the tx. The intent comes from the hub, never from the agent.
 */

import { sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import {
  type EvmReceipt,
  cancelPayload,
  createIntentPayload,
  hubCancelTx,
  intentChainId,
  intentHash,
  userHubWallet,
} from "../sodax.js";
import { ActionError } from "./errors.js";
import { type StepTx, toStepTx } from "./quote.js";
import { type CachedQuote, claimDeposit, markHubOutcome } from "./quoteCache.js";
import {
  type NotCancellable,
  RETRY_AFTER_SEC,
  type SwapRef,
  type SwapSource,
  intentClosed,
  readReceipt,
  resolveSource,
  whyNotCancellable,
} from "./source.js";
import { HUB_RELAY_ID, INTENT_CANCELLED_TOPIC, decodeSendMessage, holdsCancel, hubLogged } from "./sourceTx.js";
import { type EvmTx, type Intent, buildCancel, getHubIntent, getSubmitTxStatus, relaySpokeTx } from "./swapsApi.js";
import { checkQuoteDeposit, deadlineMs, refundExpired, untilRefundSec } from "./track.js";

export type CancelState =
  | {
      status: "not_cancellable";
      /** `closed`: the hub no longer holds the intent. `not_this_swap`: the tx didn't create the quote's intent. */
      reason: NotCancellable | "not_sent" | "closed" | "not_this_swap";
    }
  /** The quote's deposit is on chain, never submitted: from its deadline on, a cancel call refunds it. */
  | { status: "deposit_unsubmitted"; retryAfterSec: number }
  /** That refund's relay failed; the next call tries again. */
  | { status: "expired_unsubmitted"; alerted: boolean; retryAfterSec: number }
  | { status: "ready"; steps: [{ kind: "cancel"; chainId: number; tx: StepTx }] }
  | { status: "cancel_awaiting_confirmation"; retryAfterSec: number }
  | { status: "cancel_failed" }
  | { status: "not_a_cancel_tx" }
  | { status: "cancel_relayed" }
  /** A swap from the hub: the cancel ran there, so nothing is relayed. */
  | { status: "cancel_confirmed" };

export type CancelResult = SwapRef & CancelState;

export async function cancelSwap(input: {
  txHash: string;
  quoteId?: string;
  chain?: string;
  cancelTxHash?: string;
}): Promise<CancelResult> {
  const txHash = input.txHash.toLowerCase();
  const cancelTxHash = input.cancelTxHash?.toLowerCase();
  const source = await resolveSource(input);
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

  // The swap first: a sent cancel is only worth waiting for if there's something to cancel.
  const row = await getSubmitTxStatus(txHash, source.chain.key);
  // A deposit this server relayed for refund has no backend row; its quote is the record.
  if (!row && quote?.handedOver === "relayed_for_refund" && quote.depositTxHash === txHash) {
    return { ...base, status: "not_cancellable", reason: "refunding" };
  }
  const reason = whyNotCancellable(row);
  const ended = reason === "solved" || reason === "cancelled" || reason === "refunding";
  // A swap from the hub is an intent there once mined: its quote's intent is cancelled, whatever the backend has.
  if (quote && source.kind === "hub" && !ended) {
    const fromQuote = await hubCancel(base, source, quote, cancelTxHash);
    if (fromQuote) return fromQuote;
  } else if (!row && quote && !quote.handedOver) {
    const unsubmitted = await unsubmittedDeposit(base, source, quote);
    if (unsubmitted) return unsubmitted;
  }
  const hubTxHash = row?.result?.dstIntentTxHash;
  if (reason || !hubTxHash) return { ...base, status: "not_cancellable", reason: reason ?? "not_on_hub_yet" };
  // Only a deposit track checked is the quote's: any other tx's intent says nothing about it.
  if (quote && quote.depositTxHash !== txHash) {
    throw quoteMismatch("That quote has no checked deposit in this transaction.");
  }

  const sent = cancelTxHash ? await sentCancel(base, source, cancelTxHash) : undefined;
  if (sent && "status" in sent) return sent;

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
  if (!quote && !(await isDepositsIntent(source, txHash, intent))) {
    logger.error({ "chain.key": source.chain.key }, "The hub intent isn't the tracked deposit's");
    throw new ActionError("SWAP_MISMATCH", "The swap service returned an intent that isn't this deposit's.", {
      details: { chainKey: source.chain.key },
    });
  }
  if (!sent || !cancelTxHash) return readyCancel(base, source, intent, hubTxHash, quote);
  if (source.kind === "hub") return hubCancelled(base, source, intent, hubTxHash, sent, quote);
  // The payload the sent cancel must carry, built here: a Swaps API outage can't hold up a mined cancel.
  const payload = cancelPayload(intent);
  if (!payload) throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.");

  const isCancel = holdsCancel(sent, {
    connection: source.connection,
    srcAddress: intent.srcAddress,
    srcChain: intent.srcChain,
    creator: intent.creator,
    payload,
  });
  if (!isCancel) return { ...base, status: "not_a_cancel_tx" };
  if (!(await relaySpokeTx(intent.srcChain, cancelTxHash))) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX relay didn't take the cancel.");
  }
  return { ...base, status: "cancel_relayed" };
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
  const swap = await checkSwapTx(base, source, quote);
  if (swap !== "match") return swap;
  if (Date.now() < deadlineMs(quote)) {
    return { ...base, status: "deposit_unsubmitted", retryAfterSec: untilRefundSec(quote) };
  }
  if (claimDeposit(quote.quoteId, base.txHash) !== "claimed") return undefined;
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
  // A tx the quote has claimed was checked as its swap already.
  if (quote.depositTxHash !== base.txHash) {
    const swap = await checkSwapTx(base, source, quote);
    if (swap !== "match") return swap;
    if (claimDeposit(quote.quoteId, base.txHash) === "taken") {
      throw quoteMismatch("That quote was used by another transaction.");
    }
  }
  // A swap from the hub created its intent itself.
  if (!cancelTxHash) return readyCancel(base, source, quote.intent, base.txHash, quote);
  const sent = await sentCancel(base, source, cancelTxHash);
  return "status" in sent ? sent : hubCancelled(base, source, quote.intent, base.txHash, sent, quote);
}

/**
 * Whether the tx is the quote's swap, on chain: `match`, the answer for a tx that isn't mined or holds no swap (an
 * approval, say), or `undefined` for a swap track reports on.
 */
async function checkSwapTx(
  base: SwapRef,
  source: SwapSource,
  quote: CachedQuote,
): Promise<"match" | CancelResult | undefined> {
  const receipt = await readReceipt(source.chain, base.txHash);
  if (!receipt || receipt.reverted) return { ...base, status: "not_cancellable", reason: "not_sent" };
  const check = checkQuoteDeposit(receipt, source, quote);
  if (check === "not_a_deposit") return { ...base, status: "not_cancellable", reason: "not_this_swap" };
  return check === "match" ? "match" : undefined;
}

/** The cancel for the user's wallet, while the hub holds the intent: once it's filled or cancelled, one reverts. */
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
    if (quote && source.kind === "hub") markHubOutcome(quote, "closed");
    return { ...base, intentHash: hash, status: "not_cancellable", reason: "closed" };
  }
  const tx = await buildCheckedCancel(source, intent);
  return {
    ...base,
    status: "ready",
    steps: [{ kind: "cancel", chainId: source.chainId, tx: toStepTx(tx, source.chainId) }],
  };
}

/** A sent cancel's receipt, or the answer while it isn't mined or if it failed. */
async function sentCancel(base: SwapRef, source: SwapSource, cancelTxHash: string): Promise<EvmReceipt | CancelResult> {
  const receipt = await readReceipt(source.chain, cancelTxHash);
  if (receipt === null) return { ...base, status: "cancel_awaiting_confirmation", retryAfterSec: RETRY_AFTER_SEC };
  if (receipt.reverted) return { ...base, status: "cancel_failed" };
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
  receipt: EvmReceipt,
  quote?: CachedQuote,
): Promise<CancelResult> {
  if (!hubLogged(receipt, source.swapContract, INTENT_CANCELLED_TOPIC, intentHash(intent))) {
    return { ...base, status: "not_a_cancel_tx" };
  }
  // The hub deletes a cancelled intent, so the same one may be created again: an earlier cancel isn't this one's.
  const created = await readReceipt(source.chain, createdIn);
  if (!created) return { ...base, status: "cancel_awaiting_confirmation", retryAfterSec: RETRY_AFTER_SEC };
  if (!minedAfter(receipt, created)) return { ...base, status: "not_a_cancel_tx" };
  if (quote) markHubOutcome(quote, "cancelled");
  return { ...base, status: "cancel_confirmed" };
}

const minedAfter = (later: EvmReceipt, earlier: EvmReceipt) =>
  later.blockNumber > earlier.blockNumber ||
  (later.blockNumber === earlier.blockNumber && later.txIndex > earlier.txIndex);

const quoteMismatch = (message: string) =>
  new ActionError("QUOTE_MISMATCH", message, {
    nextStep: "Call again with the quoteId this transaction was made from, or with chain instead of quoteId.",
  });

/**
 * Without a quote, the hub intent must be the tracked swap's: from this chain, and alone in that tx, either a
 * deposit by the intent's source address to its creator with the calls that create this very intent, or on the
 * hub the intents contract's log of it. The creator must be that address's hub wallet, so its cancel reaches it.
 */
async function isDepositsIntent(source: SwapSource, txHash: string, intent: Intent): Promise<boolean> {
  if (intent.srcChain !== intentChainId(source.chain.key)) return false;
  // A deposit must carry the calls that create this intent; a hub swap is matched by the intent's hash alone.
  const payload = source.kind === "spoke" ? createIntentPayload(intent) : "";
  if (payload === undefined) return false;
  const receipt = await readReceipt(source.chain, txHash);
  // The deposit reached the hub, so it's mined: a node without its receipt is behind.
  if (!receipt) throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't read ${source.chain.name} right now.`);
  // As track checks a quote's: alone in its tx.
  const swap = { intent, srcAddress: intent.srcAddress, relayData: { address: intent.creator, payload } };
  if (checkQuoteDeposit(receipt, source, swap) !== "match") return false;
  const hubWallet = await userHubWallet(source.chain.key, intent.srcAddress).catch(() => {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "Couldn't look up the user's SODAX hub wallet.");
  });
  return same(hubWallet, intent.creator);
}

/** The intent fields that differ; hex in any case is the same value. */
function differingFields(quoted: Intent, hub: Intent): (keyof Intent)[] {
  return (Object.keys(quoted) as (keyof Intent)[]).filter(field => !same(String(quoted[field]), String(hub[field])));
}

/**
 * The cancel the backend builds, checked before anyone signs it: from the intent's source address,
 * to the chain's `connection`, no value, sending the user's hub wallet exactly the SDK's
 * `cancelIntent(intent)` call. The payload is what that wallet runs, so nothing else may pass.
 * From the hub the SDK builds it here: the wallet router runs that call, with no relay to check.
 */
async function buildCheckedCancel(source: SwapSource, intent: Intent): Promise<EvmTx> {
  if (source.kind === "hub") {
    const hubTx = await hubCancelTx(intent);
    if (!hubTx) throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.");
    return hubTx;
  }
  const tx = await buildCancel(source.chain.key, intent);
  const message = decodeSendMessage(tx.data);
  const payload = cancelPayload(intent);
  if (
    !message ||
    !payload ||
    !same(tx.from, intent.srcAddress) ||
    !same(tx.to, source.connection) ||
    BigInt(tx.value) !== 0n ||
    message.dstChainId !== HUB_RELAY_ID ||
    !same(message.dstAddress, intent.creator) ||
    !same(message.payload, payload)
  ) {
    logger.error(
      { "chain.key": source.chain.key, "tx.to": tx.to },
      "The Swaps API built a cancel that doesn't match the intent",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service built a different cancel than expected.", {
      details: { chainKey: source.chain.key },
    });
  }
  return tx;
}
