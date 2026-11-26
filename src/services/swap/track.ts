/**
 * `sodax_swap_submit_and_track`: the backend's status first, then the source tx on chain, then one submit.
 * Never blocks or polls: each call says where the swap is, and repeated calls never resubmit.
 *
 * Only the quote cache and chain data are trusted (ADR §Safety rules): the intent and relay
 * payload submitted are the ones quoted, and the receipt must hold that quote's deposit.
 */

import { SODAX_HELP_DESK, sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";
import { intentHash, isHubChain } from "../sodax.js";
import { TtlCache } from "../ttlCache.js";
import { alertOperator } from "./alerts.js";
import { ActionError } from "./errors.js";
import {
  type CachedQuote,
  claimDeposit,
  markHubOutcome,
  markRelayedForRefund,
  markSubmitFailed,
  markSubmitRefused,
  markSubmitted,
  trackedSince,
} from "./quoteCache.js";
import {
  RETRY_AFTER_SEC,
  type SwapRef,
  depositTerms,
  intentClosed,
  isHubSource,
  readSourceTx,
  resolveSentTx,
  seenOnChain,
  swapsIn,
  whyNotCancellable,
} from "./source.js";
import { type DepositCheck, checkDeposit } from "./sourceTx.js";
import type { SourceTx, SwapSource } from "./sources/types.js";
import { MAX_CLOCK_SKEW_SEC, type SubmitTxStatus, getSubmitTxStatus, relaySpokeTx, submitTx } from "./swapsApi.js";

/** The backend's in-flight steps, in order; `pending` is `queued`, `solved` and `failed` are terminal. */
const STAGES: readonly string[] = ["relaying", "relayed", "posting_execution", "posted_execution"];
const STATUSES: readonly string[] = ["pending", ...STAGES, "solved", "failed"];

/** For a deposit on chain that SODAX operators must move by hand. */
export const DEPOSIT_SAFE =
  "tell the user the deposit is on chain and safe, SODAX has been alerted to recover it, and they must not send it again";
/** The same when the alert reached only the logs: the hourly alert cap was full. */
export const DEPOSIT_SAFE_UNALERTED = `tell the user the deposit is on chain and safe, that they must not send it again, and to give its transaction hash to ${SODAX_HELP_DESK} to recover it`;

// A failed refund relay is retried by the next call; sooner is unlikely to help.
const REFUND_RETRY_SEC = 60;
// The backend takes a new row until 120 s past the deadline, so a refusal before it isn't the
// deadline; but refused in its last minute, no fix by hand lands in time. Its clock may be off ours
// by as much as a quote's deadline may be.
const REFUND_AT_ONCE_SEC = 60 + MAX_CLOCK_SKEW_SEC;
// A tx sent just before the deadline may reach this chain's node a little later.
const UNSEEN_AFTER_DEADLINE_SEC = 5 * 60;
// How long a tx no node has seen is polled for, from the first call: about as long as 30 polls take. After that the
// agent waits for the user to say it was sent, as a wallet may broadcast late.
const UNSEEN_POLL_SEC = 15 * 60;
// Whether a node has seen a tx with no receipt yet, per caller, for a few seconds however often they track it: an
// unseen tx isn't read again in that time, a seen one only for its receipt.
const seenTx = new TtlCache(10_000, 1_000);

export type TrackOutcome = "cancelled" | "refunding" | "abandoned" | "cancel_to_recover" | "unknown";

/** Where the swap is. */
export type TrackState =
  | {
      status: "awaiting_source_confirmation";
      seenOnChain: boolean;
      retryAfterSec: number;
      /** A tx no node has seen, with its quote: from this time on it's `source_not_found`. */
      stopAfter?: string;
      /** Until when that tx is polled for; once past, the agent asks the user instead, and `retryAfterSec` runs past `stopAfter`. */
      pollUntil?: string;
    }
  | { status: "source_failed" }
  /** Failed after its deposit ran (NEAR keeps receipts that ran): not submitted, so the funds wait for an operator. */
  | { status: "source_failed"; depositHeld: true; alerted: boolean; notThisQuote?: true }
  | { status: "source_not_found" }
  | { status: "not_submitted"; reason: "not_a_deposit" }
  | {
      status: "not_submitted";
      reason: "deposit_mismatch" | "other_sender" | "quote_used" | "multiple_deposits" | "unverified";
      alerted: boolean;
    }
  | { status: "not_submitted_unknown_quote"; isDeposit: boolean; alerted: boolean }
  /** A spoke's deposit relayed past its deadline: its hub intent is refunded. */
  | { status: "expired_refunding" }
  /** A hub swap past its deadline, never submitted: the backend's canceller refunds it, unless a solver fills it first. */
  | { status: "expired_awaiting_refund" }
  /** A hub swap never submitted whose intent is gone from the hub: filled by a solver, or cancelled or refunded. */
  | { status: "intent_closed" }
  | { status: "expired_unsubmitted"; alerted: boolean; retryAfterSec: number }
  /** Refused before its deadline: the first call after it starts the refund. */
  | { status: "submit_refused"; alerted: boolean; retryAfterSec: number }
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
  /** `failure`: how the backend's failed row ended (the result's `outcome` is where the funds are). */
  | { status: "failed"; failedAtStep?: string; failure: TrackOutcome; canCancel: boolean }
  /** A backend status this server doesn't know, past the quote's deadline or without a quote. */
  | { status: "unknown" };

export type TrackResult = SwapRef & TrackState;

// One check per caller, quote and tx at a time: submit-tx allows 10 a minute per IP unless the key's org has a limit.
const inFlight = new Map<string, Promise<TrackResult>>();

// Agents can't wait between calls, so a call waits briefly for the swap to move on. Mutable for tests.
export const trackWait = {
  stepMs: 5_000,
  maxMs: 20_000,
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};
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
    await trackWait.sleep(trackWait.stepMs);
    result = await trackSwap(input);
    if (stateOf(result) !== first) break;
  }
  return result;
}

export async function trackSwap(input: { txHash: string; quoteId?: string; chain?: string }): Promise<TrackResult> {
  const { source, txHash } = await resolveSentTx(input);
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
  const base = { txHash, chain, ...(quoteId && { quoteId }), ...(quote && { intentHash: intentHash(quote.intent) }) };
  // A row is this quote's only once the tx was checked as its deposit; until then it may be another swap's.
  const claimed = quote?.depositTxHash === txHash;
  // An unseen tx is worth waiting for only while its quote can still be sent; polled for only a while of that.
  const unseen = quote && !claimed ? unseenWait(quote, txHash) : undefined;
  const sendable = unseen !== undefined && Date.now() < unseen.stopAfterMs;
  const memoKey = JSON.stringify([callerKeyHash(), chain.key, txHash]);
  // No node had it seconds ago: nothing new to read, and a quote's unchecked tx has no row of its own anyway.
  if (sendable && seenTx.get<boolean>(memoKey) === false) return awaitingSource(base, false, unseen);
  // The hub logged its cancel, which a backend row may not show yet.
  if (claimed && quote.handedOver === "cancelled") return { ...base, ...handedOverState("cancelled") };

  const row = await getSubmitTxStatus(txHash, chain.key).catch(error => {
    throw claimed ? retryable(error) : error;
  });
  // Found closed on the hub: a lagging row would offer a cancel that cancel refuses. Only its fill says more.
  if (claimed && quote.handedOver === "closed" && row?.status !== "solved") return { ...base, status: "intent_closed" };
  if (row && (!quote || claimed)) return { ...base, ...fromStatus(row, claimed ? quote : undefined) };
  // Already handed over by this server: the backend's row may lag its answer, and a resubmit costs
  // one of the 10 submits a minute this server's IP gets.
  if (claimed && quote.handedOver) {
    if (quote.handedOver === "left_to_refund") return hubExpired(base, quote);
    return { ...base, ...handedOverState(quote.handedOver) };
  }
  // A resubmit before the deadline is refused again, and costs one of those 10 submits.
  if (claimed && quote.submitRefused && Date.now() < deadlineMs(quote)) {
    // Deduped: the first refusal's alert, or another try if that one reached only the log.
    const alerted = refused(base, source, quote);
    return { ...base, status: "submit_refused", alerted, retryAfterSec: untilRefundSec(quote) };
  }
  if (claimed) return submitDeposit(base, source, quote);

  // A remembered answer saves reads only while the result is to wait anyway: a final one reads the chain again.
  const known = sendable ? seenTx.get<boolean>(memoKey) : null;
  const receipt = known === false ? null : await readSourceTx(source, txHash, quote?.srcAddress);
  if (!receipt) {
    const seen = known ?? (await seenOnChain(source, txHash, quote?.srcAddress));
    // Remembered where its nodes can't say too: a quoted tx no node has is read at most every 10 s per API key.
    if (known === null) seenTx.set(memoKey, seen === true);
    if (!seen && !sendable) return { ...base, status: "source_not_found" };
    return awaitingSource(base, seen === true, seen ? undefined : unseen);
  }
  if (receipt.failed) return failedSource(base, source, receipt);
  if (receipt.kind === "spoke" && receipt.unreadable) return unverified(base, receipt.unreadable.failed, quote);
  if (!quote) return withoutQuote(base, source, receipt);
  const deposit = checkQuoteDeposit(source, receipt, quote);
  if (deposit === "multiple_deposits") {
    const alerted = alertStranded(source, "multiple_deposits", { chainKey: chain.key, txHash, quoteId: quote.quoteId });
    return { ...base, status: "not_submitted", reason: "multiple_deposits", alerted };
  }
  if (deposit !== "match") return notThisDeposit(base, deposit, quote);
  const claim = claimDeposit(quote.quoteId, txHash);
  // Dropped from the cache during the reads above.
  if (claim === "gone") return withoutQuote(base, source, receipt);
  // Both deposits carry the same intent id, so only the first can become an intent.
  if (claim === "taken") {
    const alerted = alertStranded(source, "quote_used", { chainKey: chain.key, txHash, quoteId: quote.quoteId });
    return { ...base, status: "not_submitted", reason: "quote_used", alerted };
  }
  if (row) return { ...base, ...fromStatus(row, quote) };
  return submitDeposit(base, source, quote);
}

/**
 * Submits a checked deposit, or past its deadline relays it for refund. The claim is its proof: it isn't read
 * again, so a node that has since dropped the tx can't hold up the submit or the refund.
 */
async function submitDeposit(base: SwapRef, source: SwapSource, quote: CachedQuote): Promise<TrackResult> {
  const { txHash, chain } = base;
  // From the deadline on it's relayed, not submitted: the hub intent that creates is refunded by the
  // backend's canceller, as its own expired rows are.
  if (Date.now() >= deadlineMs(quote)) return refundExpired(base, quote, source);
  // Each submit counts against submit-tx's limit (per IP, or the key's org): a retry sooner than told waits.
  const waitMs = (quote.submitRetryAt ?? 0) - Date.now();
  if (waitMs > 0) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "This deposit was submitted moments ago.", {
      details: { retryAfterSec: Math.ceil(waitMs / 1000) },
    });
  }
  // A hub intent cancelled (from another app, or before the cancel was confirmed here) or filled: nothing to submit.
  if (isHubSource(source) && (await intentClosed(intentHash(quote.intent), txHash))) return hubClosed(base, quote);

  try {
    await submitTx({
      txHash,
      srcChainKey: chain.key,
      walletAddress: quote.srcAddress,
      intent: quote.intent,
      relayData: quote.relayData.payload,
    });
  } catch (error) {
    // A failure that may pass may also have reached the backend, so the claim stays and a repeat submits again.
    if (!isRefusal(error)) {
      const failure = retryable(error);
      const told = failure instanceof ActionError ? Number(failure.details?.retryAfterSec ?? RETRY_AFTER_SEC) : 0;
      markSubmitFailed(quote.quoteId, Math.min(told, RETRY_AFTER_SEC));
      throw failure;
    }
    // A refusal of the swap itself, an amount one too, comes after the deposit: never the quote-time advice.
    const alerted = refused(base, source, quote);
    // A deposit is still relayed to be refunded: now near the deadline, else on the first call after it. A hub
    // intent is only refunded once expired, so it waits for that call.
    const nearDeadline = Date.now() >= deadlineMs(quote) - REFUND_AT_ONCE_SEC * 1000;
    if (!isHubSource(source) && nearDeadline) return refundExpired(base, quote, source);
    markSubmitRefused(quote.quoteId);
    return { ...base, status: "submit_refused", alerted, retryAfterSec: untilRefundSec(quote) };
  }
  markSubmitted(quote.quoteId);
  logger.info(
    { "chain.key": chain.key, "quote.id": quote.quoteId, "tx.hash": txHash, "intent.hash": base.intentHash },
    "Submitted a swap deposit",
  );
  return { ...base, status: "queued", retryAfterSec: RETRY_AFTER_SEC };
}

/** A refused submit's alert: a deposit needs an operator to recover it. */
function refused(base: SwapRef, source: SwapSource, quote: CachedQuote): boolean {
  const fields = { chainKey: base.chain.key, txHash: base.txHash, quoteId: quote.quoteId };
  return alertStranded(source, "submit_rejected", { ...fields, deadline: quote.intent.deadline });
}

/**
 * An operator alert for a deposit that may be stranded. A swap from the hub never is: its intent is there, filled or,
 * once expired, refunded by the backend's canceller, so it pages no one.
 */
function alertStranded(source: SwapSource, ...[kind, fields]: Parameters<typeof alertOperator>): boolean {
  return !isHubSource(source) && alertOperator(kind, fields);
}

/**
 * A failure that calling again won't fix. A key or WAF refusal (401/403) is of the request, not the
 * swap: past the claim it's retried, and from the deadline on the same call relays it for refund.
 */
const isRefusal = (error: unknown): error is ActionError =>
  error instanceof ActionError && !error.retryable && error.code !== "API_KEY_REQUIRED";

/** The error for the agent past the claim: never "get a new key", which leads to a second quote and deposit. */
const retryable = (error: unknown) =>
  error instanceof ActionError && error.code === "API_KEY_REQUIRED"
    ? new ActionError("UPSTREAM_UNAVAILABLE", "The swap service refused this server's request for now.", {
        details: { retryAfterSec: RETRY_AFTER_SEC },
      })
    : error;

export const deadlineMs = (quote: CachedQuote) => Number(quote.intent.deadline) * 1000;
export const untilRefundSec = (quote: CachedQuote) =>
  Math.ceil((deadlineMs(quote) - Date.now()) / 1000) + RETRY_AFTER_SEC;

type UnseenWait = { stopAfterMs: number; pollUntilMs: number };

/** For a quote's tx no node has seen yet: when it's no longer sendable, and until when it's polled for. */
function unseenWait(quote: CachedQuote, txHash: string): UnseenWait {
  const stopAfterMs = deadlineMs(quote) + UNSEEN_AFTER_DEADLINE_SEC * 1000;
  return { stopAfterMs, pollUntilMs: Math.min(stopAfterMs, trackedSince(quote, txHash) + UNSEEN_POLL_SEC * 1000) };
}

/** A tx with no receipt yet; one no node has seen, with its quote, is tracked until its `stopAfter`. */
function awaitingSource(base: SwapRef, seenOnChain: boolean, unseen?: UnseenWait): TrackResult {
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();
  const polled = unseen !== undefined && now < unseen.pollUntilMs;
  return {
    ...base,
    status: "awaiting_source_confirmation",
    seenOnChain,
    // Past pollUntil the user is asked instead: the next call on a timer is the one after stopAfter.
    retryAfterSec: unseen && !polled ? Math.ceil((unseen.stopAfterMs - now) / 1000) + RETRY_AFTER_SEC : RETRY_AFTER_SEC,
    ...(unseen && { stopAfter: iso(unseen.stopAfterMs) }),
    ...(polled && { pollUntil: iso(unseen.pollUntilMs) }),
  };
}

/** Test only. */
export function clearUnseenMemo(): void {
  seenTx.clear();
}

/**
 * Whether the tx holds this quote's swap, and no other: the backend keys a swap on its tx and follows the tx's first
 * relay packet, whoever sent it, so any other message in the tx (another deposit, a cancel) may be the one it follows.
 * From the hub the intents contract must have logged the quoted intent's hash;
 * from a spoke, of any family, a deposit message must bind the quote's sender, hub wallet and relay payload
 * (`checkDeposit`), as the relay will read it.
 */
export function checkQuoteDeposit(
  source: SwapSource,
  sourceTx: SourceTx,
  quote: Pick<CachedQuote, "intent" | "relayData">,
): DepositCheck | "multiple_deposits" {
  if (sourceTx.kind === "hub") {
    // Another intent is anyone's: the log names no sender to tell the user's own apart, and nothing is stranded.
    const hash = intentHash(quote.intent);
    if (!sourceTx.created.some(logged => same(logged, hash))) return "not_a_deposit";
    return sourceTx.created.length > 1 ? "multiple_deposits" : "match";
  }
  const deposit = checkDeposit(sourceTx.messages, depositTerms(source, quote));
  if (deposit !== "match") return deposit;
  return sourceTx.messages.length > 1 ? "multiple_deposits" : "match";
}

/**
 * A source tx that failed. Only NEAR keeps what ran before the failure: a deposit there is held by the asset
 * manager and this server doesn't submit it, so a named quote alerts as a stranded deposit does.
 */
function failedSource(base: SwapRef, source: SwapSource, sourceTx: SourceTx): TrackResult {
  if (swapsIn(source, sourceTx) === 0) return { ...base, status: "source_failed" };
  const { txHash, chain } = base;
  const { quote } = source;
  // Only a quote this server holds alerts: a made-up quoteId could otherwise spend the alert budget.
  if (!quote) return { ...base, status: "source_failed", depositHeld: true, alerted: false };
  // A held deposit is recovered by hand whoever's it is; the alert says when it isn't this quote's.
  const own = ["match", "multiple_deposits"].includes(checkQuoteDeposit(source, sourceTx, quote));
  const fields = { chainKey: chain.key, txHash, quoteId: quote.quoteId, ...(!own && { reason: "not this quote's" }) };
  const alerted = alertOperator("failed_tx_deposit", fields);
  return { ...base, status: "source_failed", depositHeld: true, alerted, ...(!own && { notThisQuote: true as const }) };
}

/**
 * A tx whose events this server can't all read: it may hold a deposit, so it's neither claimed nor called anything
 * else. With a quote here, operators check it by hand.
 */
function unverified(base: SwapRef, failed: boolean, quote?: CachedQuote): TrackResult {
  const fields = {
    chainKey: base.chain.key,
    txHash: base.txHash,
    quoteId: quote?.quoteId,
    ...(failed && { reason: "the tx failed" }),
  };
  const alerted = quote !== undefined && alertOperator("unverified_tx", fields);
  return { ...base, status: "not_submitted", reason: "unverified", alerted };
}

/**
 * A mined tx that isn't this quote's deposit. A deposit the agent may have no other quoteId for alerts:
 * this quote's sent from another address, or its sender's for another intent.
 */
function notThisDeposit(base: SwapRef, deposit: Exclude<DepositCheck, "match">, quote: CachedQuote): TrackResult {
  if (deposit === "not_a_deposit") return { ...base, status: "not_submitted", reason: deposit };
  const fields = { chainKey: base.chain.key, txHash: base.txHash, quoteId: quote.quoteId };
  const alerted = alertOperator(deposit === "other_sender" ? "other_sender_deposit" : "other_quote_deposit", fields);
  return { ...base, status: "not_submitted", reason: deposit === "mismatch" ? "deposit_mismatch" : deposit, alerted };
}

/** A mined tx with no quote here (a restart, or its grace period over): a deposit may be stranded. */
function withoutQuote(base: SwapRef, source: SwapSource, sourceTx: SourceTx): TrackResult {
  const { txHash, chain, quoteId } = base;
  const isDeposit = swapsIn(source, sourceTx) > 0;
  // Only a named quoteId alerts, or any public deposit could page an operator.
  const alerted =
    isDeposit &&
    quoteId !== undefined &&
    alertStranded(source, "unknown_quote", { chainKey: chain.key, txHash, quoteId });
  return { ...base, status: "not_submitted_unknown_quote", isDeposit, alerted };
}

/**
 * What a swap this server handed over has become, from its quote: the backend may not have a row for it. One left to
 * its refund is read from the hub instead (`hubExpired`).
 */
function handedOverState(how: Exclude<NonNullable<CachedQuote["handedOver"]>, "left_to_refund">): TrackState {
  switch (how) {
    case "submitted":
      return { status: "queued", retryAfterSec: RETRY_AFTER_SEC };
    case "relayed_for_refund":
      return { status: "expired_refunding" };
    case "cancelled":
      return { status: "failed", failure: "cancelled", canCancel: false };
    case "closed":
      return { status: "intent_closed" };
  }
}

type ExpiredState = SwapRef &
  Extract<
    TrackState,
    { status: "expired_refunding" | "expired_awaiting_refund" | "expired_unsubmitted" | "intent_closed" }
  >;

/**
 * A claimed swap past its deadline. A spoke's deposit is relayed, so the hub intent it creates is refunded; a
 * swap from the hub needs no relay: its intent is already there, and the backend's canceller refunds it.
 */
export async function refundExpired(base: SwapRef, quote: CachedQuote, source: SwapSource): Promise<ExpiredState> {
  const { txHash, chain } = base;
  if (isHubSource(source)) return hubExpired(base, quote);
  let relayed: boolean;
  try {
    const data = source.adapter.commitsHash ? quote.relayData : undefined;
    relayed = await relaySpokeTx(quote.intent.srcChain, txHash, data);
  } catch (error) {
    // Refused is a relay failure; anything that may pass (a rate limit, an outage, a WAF) is retried.
    if (!isRefusal(error)) throw retryable(error);
    relayed = false;
  }
  if (relayed) {
    markRelayedForRefund(quote);
    logger.info({ "chain.key": chain.key, "quote.id": quote.quoteId }, "Relayed an expired swap deposit for refund");
    return { ...base, status: "expired_refunding" };
  }
  // The claim stays, so the next call tries the relay again.
  const alerted = alertOperator("refund_relay_failed", {
    chainKey: chain.key,
    txHash,
    quoteId: quote.quoteId,
    deadline: quote.intent.deadline,
  });
  return { ...base, status: "expired_unsubmitted", alerted, retryAfterSec: REFUND_RETRY_SEC };
}

/**
 * A hub swap past its deadline, never submitted: the backend's canceller refunds its intent, unless a solver fills
 * it first. Read from the hub on every call, so one closed since isn't offered a cancel that would revert.
 */
async function hubExpired(base: SwapRef, quote: CachedQuote): Promise<ExpiredState> {
  if (await intentClosed(intentHash(quote.intent), base.txHash)) return hubClosed(base, quote);
  if (quote.handedOver !== "left_to_refund") {
    markHubOutcome(quote, "left_to_refund");
    logger.info({ "chain.key": base.chain.key, "quote.id": quote.quoteId }, "Left an expired hub swap to its refund");
  }
  return { ...base, status: "expired_awaiting_refund" };
}

/** A hub swap never submitted whose intent is gone from the hub: filled, or cancelled or refunded. */
function hubClosed(base: SwapRef, quote: CachedQuote): SwapRef & { status: "intent_closed" } {
  markHubOutcome(quote, "closed");
  return { ...base, status: "intent_closed" };
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
      return { status: "failed", ...(failedAtStep && { failedAtStep }), failure: outcomeOf(row, canCancel), canCancel };
    }
    default: {
      const known = STAGES.includes(row.status);
      if (!known) logger.warn({ "upstream.status": row.status }, "Unknown submit-tx status");
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
