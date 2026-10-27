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
};

const MAX_QUOTES = 10_000;
// One key can't fill the cache and push out other keys' live quotes; past this many open ones
// (unclaimed, before their deadline) it waits instead.
const MAX_QUOTES_PER_KEY = 1_000;
const GRACE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Insertion order is age order, which eviction relies on.
const quotes = new Map<string, CachedQuote>();
// Per key, its open quotes' deadlines in epoch ms, by quoteId.
const openByKey = new Map<string, Map<string, number>>();
let lastSweepAt = 0;
let lastFullWarningAt = Number.NEGATIVE_INFINITY;

/** Refuses a key with too many open quotes; checked before a quote is built, and again when it's put. */
export function checkQuoteRoom(keyHash: string): void {
  const open = openByKey.get(keyHash);
  if (!open || open.size < MAX_QUOTES_PER_KEY) return;
  const now = Date.now();
  for (const [quoteId, deadlineMs] of open) if (deadlineMs <= now) open.delete(quoteId);
  if (open.size < MAX_QUOTES_PER_KEY) return;
  throw new ActionError("RATE_LIMITED", "This API key has too many open swap quotes.", {
    details: { retryAfterSec: Math.ceil((Math.min(...open.values()) - now) / 1000) },
  });
}

export function putQuote(quote: Omit<CachedQuote, "quoteId" | "expiresAt">): CachedQuote {
  checkQuoteRoom(quote.keyHash);
  const now = Date.now();
  // Expired quotes go once a minute, and whenever the cache is full: a live quote is only
  // dropped when nothing expired is left. Deadlines differ, so age order isn't expiry order.
  if (quotes.size >= MAX_QUOTES || now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    for (const cached of quotes.values()) if (cached.expiresAt <= now) drop(cached);
  }
  if (quotes.size >= MAX_QUOTES) {
    const oldest = quotes.values().next().value;
    if (oldest) drop(oldest);
    if (now - lastFullWarningAt >= SWEEP_INTERVAL_MS) {
      lastFullWarningAt = now;
      logger.warn("The quote cache is full; dropping the oldest live quotes");
    }
  }
  const deadlineMs = Number(quote.deadline) * 1000;
  const entry = { ...quote, quoteId: randomUUID(), expiresAt: deadlineMs + GRACE_MS };
  quotes.set(entry.quoteId, entry);
  const open = openByKey.get(entry.keyHash) ?? new Map<string, number>();
  open.set(entry.quoteId, deadlineMs);
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
