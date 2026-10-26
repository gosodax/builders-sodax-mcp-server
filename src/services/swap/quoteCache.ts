/**
 * Quotes ready to sign, by `quoteId`, so the agent never retypes the intent's
 * bigint fields and track/cancel trust only what was quoted. In memory: a quote
 * lost to a restart can't be submitted from here (see ADR §Quote cache).
 */

import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { BuiltIntent, IntentRequest } from "./swapsApi.js";

export type CachedQuote = IntentRequest & {
  quoteId: string;
  intent: BuiltIntent["intent"];
  relayData: BuiltIntent["relayData"];
  /** Epoch ms: the deadline plus a grace period, so a tx signed near expiry can still be tracked. */
  expiresAt: number;
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

export function getCachedQuote(quoteId: string): CachedQuote | undefined {
  const quote = quotes.get(quoteId);
  if (quote && quote.expiresAt <= Date.now()) {
    quotes.delete(quoteId);
    return undefined;
  }
  return quote;
}

export function clearQuoteCache(): void {
  quotes.clear();
  lastSweepAt = 0;
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
}
