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
import { ActionError } from "./errors.js";
import type { BuiltIntent, IntentRequest } from "./swapsApi.js";

export type CachedQuote = IntentRequest & {
  quoteId: string;
  intent: BuiltIntent["intent"];
  relayData: BuiltIntent["relayData"];
  /** SHA-256 of the creator's API key. */
  keyHash: string;
  /** The least the recipient gets, as track reports it once the swap is solved. */
  minimumReceived: { amount: string; symbol: string; chainName: string };
  /** Epoch ms: the deadline plus a grace period, so a tx signed near expiry can still be tracked. */
  expiresAt: number;
  /** The deposit checked as this quote's. One intent can only come from one deposit, so the claim stays. */
  depositTxHash?: string;
  /** How that deposit left this server: submitted to the backend, or relayed after its deadline for a refund. */
  handedOver?: "submitted" | "relayed_for_refund";
  /** The backend refused its submit before the deadline; it's relayed for refund after it. */
  submitRefused?: true;
};

const MAX_QUOTES = 10_000;
// One key can't fill the cache and crowd out other keys' quotes; past this many unclaimed ones in
// the cache it waits instead.
const MAX_QUOTES_PER_KEY = 1_000;
const GRACE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Insertion order is age order, which eviction relies on.
const quotes = new Map<string, CachedQuote>();
// Per key, its unclaimed quotes' expiry in epoch ms, by quoteId.
const openByKey = new Map<string, Map<string, number>>();
let lastSweepAt = 0;
let lastFullWarningAt = Number.NEGATIVE_INFINITY;

/**
 * Refuses a key with too many open quotes, or any key while the cache is full of quotes it can't drop;
 * checked before a quote is built, and again when it's put.
 */
export function checkQuoteRoom(keyHash: string): void {
  const now = Date.now();
  const open = openByKey.get(keyHash);
  if (open && open.size >= MAX_QUOTES_PER_KEY) {
    for (const [quoteId, expiresAt] of open) if (expiresAt <= now) open.delete(quoteId);
    if (open.size >= MAX_QUOTES_PER_KEY) {
      throw new ActionError("RATE_LIMITED", "This API key has too many open swap quotes.", {
        details: { retryAfterSec: Math.ceil((Math.min(...open.values()) - now) / 1000) },
      });
    }
  }
  if (quotes.size >= MAX_QUOTES && !makeRoom(now)) {
    if (now - lastFullWarningAt >= SWEEP_INTERVAL_MS) {
      lastFullWarningAt = now;
      logger.warn("The quote cache is full of live and claimed quotes; refusing new ones");
    }
    throw new ActionError("RATE_LIMITED", "This server holds too many open swap quotes right now.", {
      details: { retryAfterSec: SWEEP_INTERVAL_MS / 1000 },
    });
  }
}

/**
 * Drops expired quotes, then if still full the oldest unclaimed one past its deadline. A live quote may be
 * signed already, and a claimed one holds a deposit, so neither is dropped to make room.
 */
function makeRoom(now: number): boolean {
  sweep(now);
  if (quotes.size < MAX_QUOTES) return true;
  for (const cached of quotes.values()) {
    if (cached.depositTxHash === undefined && Number(cached.deadline) * 1000 <= now) {
      drop(cached);
      return true;
    }
  }
  return false;
}

function sweep(now: number): void {
  lastSweepAt = now;
  for (const cached of quotes.values()) if (cached.expiresAt <= now) drop(cached);
}

export function putQuote(quote: Omit<CachedQuote, "quoteId" | "expiresAt">): CachedQuote {
  checkQuoteRoom(quote.keyHash);
  const now = Date.now();
  // Deadlines differ, so age order isn't expiry order: expired quotes go in a sweep once a minute.
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) sweep(now);
  const entry = { ...quote, quoteId: randomUUID(), expiresAt: Number(quote.deadline) * 1000 + GRACE_MS };
  quotes.set(entry.quoteId, entry);
  const open = openByKey.get(entry.keyHash) ?? new Map<string, number>();
  open.set(entry.quoteId, entry.expiresAt);
  openByKey.set(entry.keyHash, open);
  return entry;
}

function drop(quote: CachedQuote): void {
  quotes.delete(quote.quoteId);
  close(quote);
}

/** No longer counts toward its key's cap: claimed, or gone. */
function close(quote: CachedQuote): void {
  const open = openByKey.get(quote.keyHash);
  open?.delete(quote.quoteId);
  if (open?.size === 0) openByKey.delete(quote.keyHash);
}

/** The quote, `undefined` if it's gone, or `"key_mismatch"` if another key made it. */
export function getCachedQuote(quoteId: string, keyHash: string): CachedQuote | "key_mismatch" | undefined {
  const quote = quotes.get(quoteId);
  if (!quote) return undefined;
  if (quote.expiresAt <= Date.now()) {
    drop(quote);
    return undefined;
  }
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

export function markSubmitted(quoteId: string): void {
  const quote = quotes.get(quoteId);
  if (quote) quote.handedOver = "submitted";
}

export function markSubmitRefused(quoteId: string): void {
  const quote = quotes.get(quoteId);
  if (quote) quote.submitRefused = true;
}

// A relayed deposit has no backend row, so its quote is the only record that it's being refunded.
const RELAYED_RETENTION_MS = 24 * 60 * 60 * 1000;

export function markRelayedForRefund(quote: CachedQuote): void {
  quote.handedOver = "relayed_for_refund";
  quote.expiresAt = Math.max(quote.expiresAt, Date.now() + RELAYED_RETENTION_MS);
  // Put back if it was dropped while the relay ran.
  if (!quotes.has(quote.quoteId)) quotes.set(quote.quoteId, quote);
}

export function clearQuoteCache(): void {
  quotes.clear();
  openByKey.clear();
  lastSweepAt = 0;
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
}
