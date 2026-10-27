/**
 * `sodax_swap_track`: the backend's status first, then the source tx on chain, then one submit.
 * Never blocks or polls: each call says where the swap is, and repeated calls never resubmit.
 *
 * Only the quote cache and chain data are trusted (ADR §Safety rules): the intent and relay
 * payload submitted are the ones quoted, and the receipt must hold that quote's deposit.
 */

import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";
import { isHubChain } from "../sodax.js";
import { alertOperator } from "./alerts.js";
import { ActionError } from "./errors.js";
import { type CachedQuote, claimDeposit, markRelayedForRefund, markSubmitted } from "./quoteCache.js";
import {
  RETRY_AFTER_SEC,
  type SwapRef,
  type SwapSource,
  readReceipt,
  resolveSource,
  seenOnChain,
  whyNotCancellable,
} from "./source.js";
import { checkDeposit, depositMessages } from "./sourceTx.js";
import { type SubmitTxStatus, getSubmitTxStatus, relaySpokeTx, submitTx } from "./swapsApi.js";

/** The backend's in-flight steps, in order; `pending` is `queued`, `solved` and `failed` are terminal. */
const STAGES: readonly string[] = ["relaying", "relayed", "posting_execution", "posted_execution"];
const STATUSES: readonly string[] = ["pending", ...STAGES, "solved", "failed"];

/** For a deposit on chain that SODAX operators must move by hand. */
export const DEPOSIT_SAFE =
  "tell the user the deposit is on chain and safe, SODAX has been alerted to recover it, and they must not send it again";

// A refund relay that failed is tried again on the next call, not sooner.
const REFUND_RETRY_SEC = 60;
// How far ahead of ours the backend's clock may be when it refuses a deposit as past its deadline.
const DEADLINE_SKEW_SEC = 60;

export type TrackOutcome = "cancelled" | "refunding" | "abandoned" | "cancel_to_recover" | "unknown";

/** Where the swap is. */
export type TrackState =
  | { status: "awaiting_source_confirmation"; seenOnChain: boolean; retryAfterSec: number }
  | { status: "source_failed" }
  | { status: "not_submitted"; reason: "not_a_deposit" | "deposit_mismatch" | "quote_used" }
  | { status: "not_submitted_unknown_quote"; alerted: boolean }
  | { status: "expired_refunding" }
  | { status: "expired_unsubmitted"; alerted: true; retryAfterSec: number }
  | { status: "queued"; retryAfterSec: number }
  | { status: "in_progress"; stage: string; hubTxHash?: string; retryAfterSec: number }
  | {
      status: "solved";
      hubTxHash?: string;
      fillTxHash?: string;
      minimumReceived?: CachedQuote["minimumReceived"];
      /** With the quote: `complete` to a hub recipient, else `in_transit` (one more cross-chain hop). */
      delivery?: "complete" | "in_transit";
    }
  | { status: "failed"; failedAtStep?: string; outcome: TrackOutcome; canCancel: boolean };

export type TrackResult = SwapRef & TrackState;

// One check per caller, quote and tx at a time: submit-tx allows 10 a minute for this server's whole IP.
const inFlight = new Map<string, Promise<TrackResult>>();

export async function trackSwap(input: { txHash: string; quoteId?: string; chain?: string }): Promise<TrackResult> {
  // The backend keys rows on the exact string, so one spelling per hash.
  const txHash = input.txHash.toLowerCase();
  const source = await resolveSource(input);
  const key = JSON.stringify([callerKeyHash(), source.chain.key, txHash, input.quoteId ?? null]);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = track(txHash, source, input.quoteId).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

async function track(txHash: string, source: SwapSource, quoteId?: string): Promise<TrackResult> {
  const { chain, quote } = source;
  const base = { txHash, chain, ...(quoteId && { quoteId }) };
  const row = await getSubmitTxStatus(txHash, chain.key);
  // A row is this quote's only once the tx was checked as its deposit; until then it may be another swap's.
  const claimed = quote?.depositTxHash === txHash;
  if (row && (!quote || claimed)) return { ...base, ...fromStatus(row, claimed ? quote : undefined) };
  // Already handed over by this server: the backend's row may lag its answer, and a resubmit costs
  // one of the 10 submits a minute this server's IP gets.
  if (claimed && quote.handedOver) {
    return quote.handedOver === "relayed_for_refund"
      ? { ...base, status: "expired_refunding" }
      : { ...base, status: "queued", retryAfterSec: RETRY_AFTER_SEC };
  }

  const receipt = await readReceipt(chain, txHash);
  if (!receipt) {
    return {
      ...base,
      status: "awaiting_source_confirmation",
      seenOnChain: await seenOnChain(chain, txHash),
      retryAfterSec: RETRY_AFTER_SEC,
    };
  }
  if (receipt.reverted) return { ...base, status: "source_failed" };
  if (!quote) {
    // No quote here (a restart, its grace period over, or never passed): a deposit may be stranded.
    const alerted = depositMessages(receipt, source.connection, source.assetManager).length > 0;
    if (alerted) alertOperator("unknown_quote", { chainKey: chain.key, txHash, quoteId });
    return { ...base, status: "not_submitted_unknown_quote", alerted };
  }
  const deposit = checkDeposit(receipt, {
    connection: source.connection,
    assetManager: source.assetManager,
    srcChain: quote.intent.srcChain,
    srcAddress: quote.srcAddress,
    relayData: quote.relayData,
  });
  if (deposit !== "match") {
    return { ...base, status: "not_submitted", reason: deposit === "mismatch" ? "deposit_mismatch" : "not_a_deposit" };
  }
  // Both deposits carry the same intent id, so only the first can become an intent.
  if (!claimDeposit(quote.quoteId, txHash)) {
    alertOperator("quote_used", { chainKey: chain.key, txHash, quoteId: quote.quoteId });
    return { ...base, status: "not_submitted", reason: "quote_used" };
  }
  if (row) return { ...base, ...fromStatus(row, quote) };
  // The backend refuses a new row past the deadline; relaying creates the hub intent, which its
  // canceller then refunds (as the backend does for its own expired rows).
  const deadlineMs = Number(quote.intent.deadline) * 1000;
  if (Date.now() >= deadlineMs) return relayForRefund(base, quote);

  try {
    await submitTx({
      txHash,
      srcChainKey: chain.key,
      walletAddress: quote.srcAddress,
      intent: quote.intent,
      relayData: quote.relayData.payload,
    });
  } catch (error) {
    // Anything else may have reached the backend, so the claim stays and a repeat submits again.
    if (!(error instanceof ActionError && error.code === "SWAP_REJECTED")) throw error;
    // At the deadline the backend's clock may already be past it: the deposit still goes to the
    // hub, so the user is filled or refunded, never left waiting.
    if (Date.now() >= deadlineMs - DEADLINE_SKEW_SEC * 1000) return relayForRefund(base, quote);
    alertOperator("submit_rejected", {
      chainKey: chain.key,
      txHash,
      quoteId: quote.quoteId,
      deadline: quote.intent.deadline,
    });
    throw new ActionError("SWAP_REJECTED", "The swap service refused this checked deposit.", {
      details: error.details,
      nextStep: `The swap service refused this deposit: ${DEPOSIT_SAFE}.`,
    });
  }
  markSubmitted(quote.quoteId);
  return { ...base, status: "queued", retryAfterSec: RETRY_AFTER_SEC };
}

async function relayForRefund(base: SwapRef, quote: CachedQuote): Promise<TrackResult> {
  const { txHash, chain } = base;
  let relayed: boolean;
  try {
    relayed = await relaySpokeTx(quote.intent.srcChain, txHash);
  } catch (error) {
    // Refused is a relay failure; anything that may pass (a rate limit, an outage, the key) is retried.
    if (!(error instanceof ActionError && error.code === "SWAP_REJECTED")) throw error;
    relayed = false;
  }
  if (relayed) {
    markRelayedForRefund(quote.quoteId);
    logger.info({ chainKey: chain.key, quoteId: quote.quoteId }, "Relayed an expired swap deposit for refund");
    return { ...base, status: "expired_refunding" };
  }
  // The claim stays, so the next call tries the relay again.
  alertOperator("refund_relay_failed", {
    chainKey: chain.key,
    txHash,
    quoteId: quote.quoteId,
    deadline: quote.intent.deadline,
  });
  return { ...base, status: "expired_unsubmitted", alerted: true, retryAfterSec: REFUND_RETRY_SEC };
}

/** The backend's record in our words: enums and hashes checked at the API boundary, never its text. */
function fromStatus(row: SubmitTxStatus, quote?: CachedQuote): TrackState {
  const hubTxHash = row.result?.dstIntentTxHash;
  const fillTxHash = row.result?.fillTxHash;
  switch (row.status) {
    case "pending":
      return { status: "queued", retryAfterSec: RETRY_AFTER_SEC };
    case "solved":
      return {
        status: "solved",
        ...(hubTxHash && { hubTxHash }),
        ...(fillTxHash && { fillTxHash }),
        ...(quote && {
          minimumReceived: quote.minimumReceived,
          delivery: isHubChain(quote.dstChainKey) ? "complete" : "in_transit",
        }),
      };
    case "failed": {
      // The same rule sodax_swap_cancel applies, so track never offers a cancel that cancel refuses.
      const canCancel = whyNotCancellable(row) === undefined;
      const failedAtStep = STATUSES.includes(row.failedAtStep ?? "") ? row.failedAtStep : undefined;
      return { status: "failed", ...(failedAtStep && { failedAtStep }), outcome: outcomeOf(row, canCancel), canCancel };
    }
    default: {
      const known = STAGES.includes(row.status);
      if (!known) logger.warn({ status: row.status }, "Unknown submit-tx status");
      return {
        status: "in_progress",
        stage: known ? row.status : "unknown",
        ...(hubTxHash && { hubTxHash }),
        retryAfterSec: RETRY_AFTER_SEC,
      };
    }
  }
}

function outcomeOf(row: SubmitTxStatus, canCancel: boolean): TrackOutcome {
  if (row.intentCancelled) return "cancelled";
  if (row.relayedForRefundAt) return "refunding";
  if (row.abandonedAt) return "abandoned";
  return canCancel ? "cancel_to_recover" : "unknown";
}
