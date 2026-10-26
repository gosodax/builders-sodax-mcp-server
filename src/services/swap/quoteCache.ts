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
  /** The deposit submitted for this quote; one intent can only come from one deposit. */
  submittedTxHash?: string;
  /** Set once an expired deposit was relayed so the backend refunds it. */
  relayedForRefund?: boolean;
};

const MAX_QUOTES = 10_000;
const GRACE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Insertion order is age order, which eviction relies on.
const quotes = new Map<string, CachedQuote>();
let lastSweepAt = 0;
let lastFullWarningAt = Number.NEGATIVE_INFINITY;

export function putQuote(quote: Omit<CachedQuote, "quoteId" | "expiresAt">): CachedQuote {
  const now = Date.now();
  // Expired quotes go once a minute, and whenever the cache is full: a live quote is only
  // dropped when nothing expired is left. Deadlines differ, so age order isn't expiry order.
  if (quotes.size >= MAX_QUOTES || now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    for (const [quoteId, cached] of quotes) if (cached.expiresAt <= now) quotes.delete(quoteId);
  }
  if (quotes.size >= MAX_QUOTES) {
    const oldest = quotes.keys().next().value;
    if (oldest !== undefined) quotes.delete(oldest);
    if (now - lastFullWarningAt >= SWEEP_INTERVAL_MS) {
      lastFullWarningAt = now;
      logger.warn("The quote cache is full; dropping the oldest live quotes");
    }
  }
  const entry = { ...quote, quoteId: randomUUID(), expiresAt: Number(quote.deadline) * 1000 + GRACE_MS };
  quotes.set(entry.quoteId, entry);
  return entry;
}

/** The quote, `undefined` if it's gone, or `"key_mismatch"` if another key made it. */
export function getCachedQuote(quoteId: string, keyHash: string): CachedQuote | "key_mismatch" | undefined {
  const quote = quotes.get(quoteId);
  if (!quote) return undefined;
  if (quote.expiresAt <= Date.now()) {
    quotes.delete(quoteId);
    return undefined;
  }
  return quote.keyHash === keyHash ? quote : "key_mismatch";
}

export function markSubmitted(quoteId: string, txHash: string): void {
  const quote = quotes.get(quoteId);
  if (quote) quote.submittedTxHash = txHash;
}

/** Undoes `markSubmitted` when handing the deposit over failed, so the next call tries again. */
export function releaseSubmitted(quoteId: string, txHash: string): void {
  const quote = quotes.get(quoteId);
  if (quote?.submittedTxHash === txHash && !quote.relayedForRefund) quote.submittedTxHash = undefined;
}

// A relayed deposit has no backend row, so its quote is the only record that it's being refunded.
const RELAYED_RETENTION_MS = 24 * 60 * 60 * 1000;

export function markRelayedForRefund(quoteId: string, txHash: string): void {
  const quote = quotes.get(quoteId);
  if (!quote) return;
  Object.assign(quote, {
    submittedTxHash: txHash,
    relayedForRefund: true,
    expiresAt: Math.max(quote.expiresAt, Date.now() + RELAYED_RETENTION_MS),
  });
}

export function clearQuoteCache(): void {
  quotes.clear();
  lastSweepAt = 0;
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
}
