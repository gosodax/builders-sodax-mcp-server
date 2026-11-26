/**
 * Quotes ready to sign, by `quoteId`, so the agent never retypes the intent's
 * bigint fields and track/cancel trust only what was quoted. In memory: a quote
 * lost to a restart can't be submitted from here (see ADR §Quote cache).
 *
 * A quote belongs to the API key that made it: the cache is shared by every caller,
 * so only its creator may submit, relay or alert on it.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { getRequestContext, runWithRequestContext, tagOf } from "../requestContext.js";
import {
  MAX_OPEN_PER_CLIENT,
  SIGN_WINDOW_MS,
  SIGN_WINDOW_TEXT,
  addOpen,
  freesAt,
  releasable,
  removeOpen,
  secondsUntil,
} from "../signWindow.js";
import { ActionError } from "./errors.js";
import type { BuiltIntent, IntentRequest } from "./swapsApi.js";

export type CachedQuote = IntentRequest & {
  quoteId: string;
  intent: BuiltIntent["intent"];
  relayData: BuiltIntent["relayData"];
  /** SHA-256 of the creator's API key. */
  keyHash: string;
  /** The creator's hashed IP, over HTTP: keys cost nothing to make up, so a client's open quotes are capped too. */
  clientId?: string;
  /** The least the recipient gets, as track reports it once the swap is solved. */
  minimumReceived: { amount: string; symbol: string; chainName: string };
  /** Epoch ms: the deadline plus a grace period, so a tx signed near expiry can still be tracked. */
  expiresAt: number;
  /**
   * Epoch ms: the steps are to be sent by then (`SIGN_WINDOW_MS` from preparing, or the deadline if sooner). Past it,
   * a quote with no deposit and no track call holding it may give way to a new one when room runs out; the intent's
   * own deadline is later.
   */
  signBy: number;
  /**
   * Epoch ms: a track or cancel call with a well-formed hash holds it this long, its deposit maybe on the way. Only a
   * deposit claimed (`depositTxHash`) keeps it for good.
   */
  heldUntil?: number;
  /** The deposit checked as this quote's. One intent can only come from one deposit, so the claim stays. */
  depositTxHash?: string;
  /**
   * How that deposit left this server: submitted to the backend, relayed after its deadline for a refund (from a
   * spoke). From the hub: left expired to the backend's canceller, cancelled by its user, or found closed there.
   */
  handedOver?: "submitted" | "relayed_for_refund" | HubOutcome;
  /** The backend refused its submit before the deadline; it's relayed for refund after it. */
  submitRefused?: true;
  /** Epoch ms before which a failed submit isn't tried again: no later than the agent was told to wait. */
  submitRetryAt?: number;
  /** When track was first called for a tx not yet this quote's deposit: an unseen tx is waited for from then. */
  trackedSince?: { txHash: string; at: number };
};

/** A hub swap's end, known from the hub. */
type HubOutcome = "left_to_refund" | "cancelled" | "closed";

const MAX_QUOTES = 10_000;
// One key can't fill the cache and crowd out other keys' quotes; past this many unclaimed ones in
// the cache it waits instead.
const MAX_QUOTES_PER_KEY = 1_000;
const GRACE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Insertion order is age order, which eviction relies on.
const quotes = new Map<string, CachedQuote>();
// Per key, and per client, its unclaimed quotes.
const openByKey = new Map<string, Set<string>>();
const openByClient = new Map<string, Set<string>>();
let lastFullWarningAt = Number.NEGATIVE_INFINITY;
let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Makes room for a quote, or refuses: a key or a client at its cap of unclaimed quotes first drops its oldest one that
 * can give way (`checkOpen`), a full cache its oldest one past its deadline (`makeRoom`). Checked before a quote is
 * built, and again when it's put.
 */
export function checkQuoteRoom(keyHash: string, clientId = getRequestContext().clientId): void {
  const now = Date.now();
  checkOpen(openByKey.get(keyHash), MAX_QUOTES_PER_KEY, "This API key has too many open swap quotes.", now);
  if (clientId) {
    checkOpen(openByClient.get(clientId), MAX_OPEN_PER_CLIENT, "This client has too many open swap quotes.", now);
  }
  if (quotes.size >= MAX_QUOTES && !makeRoom(now)) {
    if (now - lastFullWarningAt >= SWEEP_INTERVAL_MS) {
      lastFullWarningAt = now;
      logger.warn("The quote cache is full of live and claimed quotes; refusing new ones");
    }
    throw new ActionError("RATE_LIMITED", "This server holds too many open swap quotes right now.", {
      nextStep: "Wait retryAfterSec seconds, then try again. sodax_swap_price still works meanwhile: it holds none.",
      details: { retryAfterSec: SWEEP_INTERVAL_MS / 1000 },
    });
  }
}

/**
 * Past `max` open quotes in `open`, the oldest one past its sign-by and no longer held gives way; refused while every
 * one is still to be sent or held, until the first of them can give way.
 */
function checkOpen(open: Set<string> | undefined, max: number, message: string, now: number): void {
  if (!open || open.size < max) return;
  // Expired ones go first: the sweep comes once a minute.
  for (const quoteId of open) if ((quotes.get(quoteId)?.expiresAt ?? 0) <= now) open.delete(quoteId);
  if (open.size < max) return;
  let first = Number.POSITIVE_INFINITY;
  for (const quoteId of open) {
    const quote = quotes.get(quoteId);
    if (!quote) continue;
    if (releasable(quote, now)) {
      drop(quote);
      logUnused(quote, "evicted");
      return;
    }
    first = Math.min(first, freesAt(quote));
  }
  throw new ActionError("RATE_LIMITED", message, {
    nextStep: `Tell the user too many swaps were prepared here and not yet sent, and wait retryAfterSec seconds before preparing again: a quote no one sent gives way ${SIGN_WINDOW_TEXT} after it was made. To watch a price meanwhile, use sodax_swap_price, which holds none.`,
    details: { retryAfterSec: secondsUntil(first, now) },
  });
}

/**
 * Drops expired quotes, then if still full the oldest one past its deadline, in `evictionRank` order, and last the
 * oldest before its deadline that can give way. A full cache otherwise refuses every new quote, so a swap that's safe
 * without its quote gives way, only to be answered on less precisely here.
 */
function makeRoom(now: number): boolean {
  sweep(now);
  if (quotes.size < MAX_QUOTES) return true;
  // The oldest quote of each rank, in one pass: the before-deadline one ranks last.
  const oldest: (CachedQuote | undefined)[] = [];
  for (const cached of quotes.values()) {
    const rank =
      Number(cached.deadline) * 1000 > now ? (releasable(cached, now) ? 3 : undefined) : evictionRank(cached, now);
    if (rank === undefined || oldest[rank]) continue;
    oldest[rank] = cached;
    if (rank === 0) break;
  }
  const evicted = oldest.find(Boolean);
  if (!evicted) return false;
  drop(evicted);
  if (evicted.depositTxHash === undefined) logUnused(evicted, "evicted");
  return true;
}

/**
 * Past its deadline: an unused quote first; then a swap that ended or that the backend has (`submitted`); then a hub
 * swap waiting for the canceller's refund, which loses only its early cancel here. Never a live quote, which may be
 * signed already, nor one a track call holds, whose deposit may need relaying for refund, nor a deposit claimed but not
 * handed over or relayed for refund: its quote is its only record.
 */
function evictionRank(quote: CachedQuote, now: number): 0 | 1 | 2 | undefined {
  const { depositTxHash, handedOver } = quote;
  if (depositTxHash === undefined) return releasable(quote, now) ? 0 : undefined;
  if (handedOver === "submitted" || handedOver === "cancelled" || handedOver === "closed") return 1;
  return handedOver === "left_to_refund" ? 2 : undefined;
}

/** Deadlines differ, so age order isn't expiry order: expired quotes go in a sweep once a minute. */
function sweep(now: number): void {
  for (const cached of quotes.values()) {
    if (cached.expiresAt > now) continue;
    drop(cached);
    if (cached.depositTxHash === undefined) logUnused(cached, "expired");
  }
  if (quotes.size === 0) stopSweeping();
}

/**
 * The drop-off between quote and deposit (#110): a quote gone without one, expired, or evicted past its deadline
 * from a full cache. Outside the request that swept it, whose record it isn't.
 */
function logUnused(quote: CachedQuote, reason: "expired" | "evicted"): void {
  runWithRequestContext({}, () =>
    logger.info(
      {
        "quote.id": quote.quoteId,
        "quote.drop_reason": reason,
        "chain.key": quote.srcChainKey,
        "dst_chain.key": quote.dstChainKey,
        "caller.key_hash": tagOf(quote.keyHash),
      },
      "Swap quote expired unused",
    ),
  );
}

/** Once a minute while quotes are cached, so an unused one is recorded near its expiry, a minute's worth at a time. */
function startSweeping(): void {
  // Created outside any request, so its runs don't carry the one that started it.
  sweepTimer ??= runWithRequestContext({}, () => setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS).unref());
}

function stopSweeping(): void {
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

export function putQuote(quote: Omit<CachedQuote, "quoteId" | "expiresAt" | "signBy" | "clientId">): CachedQuote {
  const { clientId } = getRequestContext();
  checkQuoteRoom(quote.keyHash, clientId);
  const deadlineMs = Number(quote.deadline) * 1000;
  const entry: CachedQuote = {
    ...quote,
    ...(clientId && { clientId }),
    quoteId: randomUUID(),
    expiresAt: deadlineMs + GRACE_MS,
    signBy: Math.min(Date.now() + SIGN_WINDOW_MS, deadlineMs),
  };
  quotes.set(entry.quoteId, entry);
  startSweeping();
  addOpen(openByKey, entry.keyHash, entry.quoteId);
  if (clientId) addOpen(openByClient, clientId, entry.quoteId);
  return entry;
}

function drop(quote: CachedQuote): void {
  quotes.delete(quote.quoteId);
  close(quote);
}

/** No longer counts toward its key's or its client's cap: claimed, or gone. */
function close(quote: CachedQuote): void {
  removeOpen(openByKey, quote.keyHash, quote.quoteId);
  if (quote.clientId) removeOpen(openByClient, quote.clientId, quote.quoteId);
}

/** The quote, `undefined` if it's gone or expired (the sweep drops it), or `"key_mismatch"` if another key made it. */
export function getCachedQuote(quoteId: string, keyHash: string): CachedQuote | "key_mismatch" | undefined {
  const quote = quotes.get(quoteId);
  if (!quote || quote.expiresAt <= Date.now()) return undefined;
  return quote.keyHash === keyHash ? quote : "key_mismatch";
}

/**
 * Claims the quote for a checked deposit. Synchronous, so a second tx tracked at the same time sees
 * the claim. `taken` if another deposit took it first, `gone` if the quote was dropped meanwhile.
 */
export function claimDeposit(quoteId: string, txHash: string): "claimed" | "taken" | "gone" {
  const quote = quotes.get(quoteId);
  if (!quote) return "gone";
  if (quote.depositTxHash === undefined) {
    quote.depositTxHash = txHash;
    close(quote);
  }
  return quote.depositTxHash === txHash ? "claimed" : "taken";
}

export function markSubmitFailed(quoteId: string, waitSec: number): void {
  const quote = quotes.get(quoteId);
  if (quote) quote.submitRetryAt = Date.now() + waitSec * 1000;
}

/** Unless the hub settled it while the submit ran: a cancel confirmed meanwhile stands. */
export function markSubmitted(quoteId: string): void {
  const quote = quotes.get(quoteId);
  if (quote && !quote.handedOver) quote.handedOver = "submitted";
}

export function markSubmitRefused(quoteId: string): void {
  const quote = quotes.get(quoteId);
  if (quote) quote.submitRefused = true;
}

// With no backend row, the quote is the only record of what became of the swap.
const HANDED_OVER_RETENTION_MS = 24 * 60 * 60 * 1000;

export function markRelayedForRefund(quote: CachedQuote): void {
  markHandedOver(quote, "relayed_for_refund");
}

/**
 * A hub swap never submitted: past its deadline, left to the backend's canceller (`left_to_refund`); cancelled by
 * its user (`cancelled`); or found closed on the hub, filled or cancelled elsewhere (`closed`).
 */
export function markHubOutcome(quote: CachedQuote, how: HubOutcome): void {
  markHandedOver(quote, how);
}

function markHandedOver(quote: CachedQuote, how: NonNullable<CachedQuote["handedOver"]>): void {
  quote.handedOver = how;
  quote.expiresAt = Math.max(quote.expiresAt, Date.now() + HANDED_OVER_RETENTION_MS);
  // Put back if it was dropped while a read or the relay ran, and swept again from then on.
  quotes.set(quote.quoteId, quote);
  startSweeping();
}

/** Since when track has been called for this quote with `txHash`: now, the first time. */
export function trackedSince(quote: CachedQuote, txHash: string): number {
  if (quote.trackedSince?.txHash !== txHash) quote.trackedSince = { txHash, at: Date.now() };
  return quote.trackedSince.at;
}

/**
 * The quotes a restart would lose before their deposit reached the backend: not handed over, not expired.
 * `/health` shows them so a deploy can wait until `open` is 0 or `openUntil` has passed.
 */
export function openQuotes(now = Date.now()): { open: number; openUntil: string | null } {
  let open = 0;
  let until = 0;
  for (const quote of quotes.values()) {
    if (quote.handedOver || quote.expiresAt <= now) continue;
    open++;
    until = Math.max(until, quote.expiresAt);
  }
  return { open, openUntil: open > 0 ? new Date(until).toISOString() : null };
}

export function clearQuoteCache(): void {
  stopSweeping();
  quotes.clear();
  openByKey.clear();
  openByClient.clear();
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
}
