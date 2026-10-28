/**
 * `sodax_swap_track`: the backend's status first, then the source tx on chain, then one submit.
 * Never blocks or polls: each call says where the swap is, and repeated calls never resubmit.
 *
 * Only the quote cache and chain data are trusted (ADR §Safety rules): the intent and relay
 * payload submitted are the ones quoted, and the receipt must hold that quote's deposit.
 */

import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";
import { type EvmReceipt, isHubChain } from "../sodax.js";
import { alertOperator } from "./alerts.js";
import { ActionError } from "./errors.js";
import {
  type CachedQuote,
  claimDeposit,
  markRelayedForRefund,
  markSubmitRefused,
  markSubmitted,
} from "./quoteCache.js";
import {
  RETRY_AFTER_SEC,
  type SwapRef,
  type SwapSource,
  readReceipt,
  resolveSource,
  seenOnChain,
  whyNotCancellable,
} from "./source.js";
import { type DepositCheck, checkDeposit, depositMessages } from "./sourceTx.js";
import { MAX_CLOCK_SKEW_SEC, type SubmitTxStatus, getSubmitTxStatus, relaySpokeTx, submitTx } from "./swapsApi.js";

/** The backend's in-flight steps, in order; `pending` is `queued`, `solved` and `failed` are terminal. */
const STAGES: readonly string[] = ["relaying", "relayed", "posting_execution", "posted_execution"];
const STATUSES: readonly string[] = ["pending", ...STAGES, "solved", "failed"];

/** For a deposit on chain that SODAX operators must move by hand. */
export const DEPOSIT_SAFE =
  "tell the user the deposit is on chain and safe, SODAX has been alerted to recover it, and they must not send it again";

// A failed refund relay is retried by the next call; sooner is unlikely to help.
const REFUND_RETRY_SEC = 60;
// The backend takes a new row until 120 s past the deadline, so a refusal before it isn't the
// deadline; but refused in its last minute, no fix by hand lands in time. Its clock may be off ours
// by as much as a quote's deadline may be.
const REFUND_AT_ONCE_SEC = 60 + MAX_CLOCK_SKEW_SEC;
// A tx sent just before the deadline may reach this chain's node a little later.
const UNSEEN_AFTER_DEADLINE_SEC = 5 * 60;

export type TrackOutcome = "cancelled" | "refunding" | "abandoned" | "cancel_to_recover" | "unknown";

/** Where the swap is. */
export type TrackState =
  | { status: "awaiting_source_confirmation"; seenOnChain: boolean; retryAfterSec: number }
  | { status: "source_failed" }
  | { status: "source_not_found" }
  | {
      status: "not_submitted";
      reason: "not_a_deposit" | "deposit_mismatch" | "other_sender" | "quote_used" | "multiple_deposits";
    }
  | { status: "not_submitted_unknown_quote"; isDeposit: boolean; alerted: boolean }
  | { status: "expired_refunding" }
  | { status: "expired_unsubmitted"; alerted: true; retryAfterSec: number }
  /** Refused before its deadline: the first call after it relays the deposit for refund. */
  | { status: "submit_refused"; alerted: true; retryAfterSec: number }
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
  | { status: "failed"; failedAtStep?: string; outcome: TrackOutcome; canCancel: boolean }
  /** A backend status this server doesn't know, past the quote's deadline or without a quote. */
  | { status: "unknown" };

export type TrackResult = SwapRef & TrackState;

// One check per caller, quote and tx at a time: submit-tx allows 10 a minute for this server's whole IP.
const inFlight = new Map<string, Promise<TrackResult>>();

// Agents can't wait between calls, so a call waits briefly for the swap to move on. Mutable for tests.
export const trackWait = { stepMs: 5_000, maxMs: 20_000 };
const WAITABLE: readonly string[] = ["awaiting_source_confirmation", "queued", "in_progress"];

/** `trackSwap`, repeated every few seconds while the swap waits, until its state changes or `maxMs` passes. */
export async function trackSwapWaiting(input: {
  txHash: string;
  quoteId?: string;
  chain?: string;
}): Promise<TrackResult> {
  const started = Date.now();
  const stateOf = (result: TrackResult) => `${result.status}:${"stage" in result ? result.stage : ""}`;
  let result = await trackSwap(input);
  const first = stateOf(result);
  while (WAITABLE.includes(result.status) && Date.now() - started + trackWait.stepMs <= trackWait.maxMs) {
    await new Promise(resolve => setTimeout(resolve, trackWait.stepMs));
    result = await trackSwap(input);
    if (stateOf(result) !== first) break;
  }
  return result;
}

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
  // A resubmit before the deadline is refused again, and costs one of those 10 submits.
  if (claimed && quote.submitRefused && Date.now() < deadlineMs(quote)) {
    return { ...base, status: "submit_refused", alerted: true, retryAfterSec: untilRefundSec(quote) };
  }

  const receipt = await readReceipt(chain, txHash);
  if (!receipt) {
    const seen = await seenOnChain(chain, txHash);
    // An unseen tx is worth waiting for only while its quote can still be sent.
    const sendable = quote && Date.now() < deadlineMs(quote) + UNSEEN_AFTER_DEADLINE_SEC * 1000;
    if (!seen && !sendable) return { ...base, status: "source_not_found" };
    return { ...base, status: "awaiting_source_confirmation", seenOnChain: seen, retryAfterSec: RETRY_AFTER_SEC };
  }
  if (receipt.reverted) return { ...base, status: "source_failed" };
  if (!quote) return withoutQuote(base, source, receipt);
  const deposit = checkQuoteDeposit(receipt, source, quote);
  if (deposit === "multiple_deposits") {
    alertOperator("multiple_deposits", { chainKey: chain.key, txHash, quoteId: quote.quoteId });
    return { ...base, status: "not_submitted", reason: "multiple_deposits" };
  }
  if (deposit !== "match") return notThisDeposit(base, deposit, quote);
  const claim = claimDeposit(quote.quoteId, txHash);
  // Dropped from the cache during the reads above.
  if (claim === "gone") return withoutQuote(base, source, receipt);
  // Both deposits carry the same intent id, so only the first can become an intent.
  if (claim === "taken") {
    alertOperator("quote_used", { chainKey: chain.key, txHash, quoteId: quote.quoteId });
    return { ...base, status: "not_submitted", reason: "quote_used" };
  }
  if (row) return { ...base, ...fromStatus(row, quote) };
  // From the deadline on it's relayed, not submitted: the hub intent that creates is refunded by the
  // backend's canceller, as its own expired rows are.
  if (Date.now() >= deadlineMs(quote)) return relayForRefund(base, quote);

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
    alertOperator("submit_rejected", {
      chainKey: chain.key,
      txHash,
      quoteId: quote.quoteId,
      deadline: quote.intent.deadline,
    });
    // The deposit still goes to the hub to be refunded: now near the deadline, else on the first call after it.
    if (Date.now() >= deadlineMs(quote) - REFUND_AT_ONCE_SEC * 1000) return relayForRefund(base, quote);
    markSubmitRefused(quote.quoteId);
    return { ...base, status: "submit_refused", alerted: true, retryAfterSec: untilRefundSec(quote) };
  }
  markSubmitted(quote.quoteId);
  logger.info({ chainKey: chain.key, quoteId: quote.quoteId }, "Submitted a swap deposit");
  return { ...base, status: "queued", retryAfterSec: RETRY_AFTER_SEC };
}

export const deadlineMs = (quote: CachedQuote) => Number(quote.intent.deadline) * 1000;
export const untilRefundSec = (quote: CachedQuote) =>
  Math.ceil((deadlineMs(quote) - Date.now()) / 1000) + RETRY_AFTER_SEC;

/**
 * Whether the receipt holds this quote's deposit, and no other: the backend keys a swap on its tx and
 * relays its first deposit, so it can't tell one from another.
 */
export function checkQuoteDeposit(
  receipt: EvmReceipt,
  source: SwapSource,
  quote: CachedQuote,
): DepositCheck | "multiple_deposits" {
  const deposit = checkDeposit(receipt, {
    connection: source.connection,
    assetManager: source.assetManager,
    srcChain: quote.intent.srcChain,
    srcAddress: quote.srcAddress,
    relayData: quote.relayData,
  });
  if (deposit !== "match") return deposit;
  return depositMessages(receipt, source.connection, source.assetManager).length > 1 ? "multiple_deposits" : "match";
}

/**
 * A mined tx that isn't this quote's deposit. A deposit the agent may have no other quoteId for alerts:
 * this quote's sent from another address, or its sender's for another intent.
 */
function notThisDeposit(base: SwapRef, deposit: Exclude<DepositCheck, "match">, quote: CachedQuote): TrackResult {
  const fields = { chainKey: base.chain.key, txHash: base.txHash, quoteId: quote.quoteId };
  if (deposit === "other_sender") alertOperator("other_sender_deposit", fields);
  if (deposit === "mismatch") alertOperator("other_quote_deposit", fields);
  const reason = deposit === "mismatch" ? "deposit_mismatch" : deposit;
  return { ...base, status: "not_submitted", reason };
}

/** A mined tx with no quote here (a restart, or its grace period over): a deposit may be stranded. */
function withoutQuote(base: SwapRef, source: SwapSource, receipt: EvmReceipt): TrackResult {
  const { txHash, chain, quoteId } = base;
  const isDeposit = depositMessages(receipt, source.connection, source.assetManager).length > 0;
  // Only a named quoteId alerts, or any public deposit could page an operator.
  const alerted = isDeposit && quoteId !== undefined;
  if (alerted) alertOperator("unknown_quote", { chainKey: chain.key, txHash, quoteId });
  return { ...base, status: "not_submitted_unknown_quote", isDeposit, alerted };
}

/** Relays a claimed deposit past its deadline, so the hub intent it creates is refunded. */
export async function relayForRefund(
  base: SwapRef,
  quote: CachedQuote,
): Promise<SwapRef & Extract<TrackState, { status: "expired_refunding" | "expired_unsubmitted" }>> {
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
    markRelayedForRefund(quote);
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
      // A status added upstream may be final: worth polling only while the quote can still be filled.
      const fillable = quote !== undefined && Date.now() < deadlineMs(quote);
      if (!known && !fillable) return { status: "unknown" };
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
