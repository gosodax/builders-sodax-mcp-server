/**
 * Where quotes are kept: in memory by default, in Redis when `REDIS_URL` is set (#125). Both apply the same rules, but
 * for which quote past its deadline a full store drops first; `quoteCache.ts` is what the swap tools call.
 */

import { logger } from "../logger.js";
import { runWithRequestContext, tagOf } from "../requestContext.js";
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
  /**
   * How that deposit left this server: submitted to the backend, relayed after its deadline for a refund (from a
   * spoke). From the hub: left expired to the backend's canceller, cancelled by its user, or found closed there.
   */
  handedOver?: HandedOver;
  /** The backend refused its submit before the deadline; it's relayed for refund after it. */
  submitRefused?: true;
  /** Epoch ms before which a failed submit isn't tried again: no later than the agent was told to wait. */
  submitRetryAt?: number;
  /** When track was first called for a tx not yet this quote's deposit: an unseen tx is waited for from then. */
  trackedSince?: { txHash: string; at: number };
};

/** A hub swap's end, known from the hub. */
export type HubOutcome = "left_to_refund" | "cancelled" | "closed";
export type HandedOver = "submitted" | "relayed_for_refund" | HubOutcome;

// A hub swap's outcomes in the order they can follow each other. Redis's HAND_OVER script keeps the same order.
const HUB_ORDER: Partial<Record<HandedOver, number>> = { left_to_refund: 1, closed: 2, cancelled: 3 };

/** A hub outcome that came before `current`, as a write replayed late (by another server, say) brings: it's dropped. */
export function outranked(how: HandedOver, current: HandedOver | undefined): boolean {
  const [next, now] = [HUB_ORDER[how], current && HUB_ORDER[current]];
  return next !== undefined && now !== undefined && next < now;
}

export const MAX_QUOTES = 10_000;
// One key can't fill the store and crowd out other keys' quotes; past this many unclaimed ones it waits instead.
export const MAX_QUOTES_PER_KEY = 1_000;
// With no backend row, the quote is the only record of what became of the swap.
export const HANDED_OVER_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A quote gone without a deposit: expired, or evicted past its deadline from a full store. */
export type UnusedQuote = Pick<CachedQuote, "quoteId" | "srcChainKey" | "dstChainKey" | "keyHash"> & {
  reason: "expired" | "evicted";
};

/** Whether a new quote fits, and the unused quotes dropped to make room. */
export type Room = { unused: UnusedQuote[] } & (
  | { full?: undefined }
  /** The key has its cap of open quotes; the first of them expires at `retryAt` (epoch ms). */
  | { full: "key"; retryAt: number }
  /** The store is full of quotes it can't drop. */
  | { full: "store" }
);

export type RelayClaim = "go" | { busyUntil: number } | HandedOver;

/** The quotes whose deposit hasn't reached the backend yet: how many, and when the last of them expires (epoch ms). */
export type OpenQuotes = { open: number; until: number };

/**
 * A method that weighs expiry takes the caller's clock: it's decided by this server's time, not the store's. `get`
 * returns a copy; a change to a quote that's gone is a no-op, except `handOver`, which puts it back.
 */
export interface QuoteStore {
  readonly kind: "memory" | "redis";
  /**
   * Room for one more quote of `keyHash`: drops expired quotes, then, if still full, one past its deadline (memory:
   * the oldest put; Redis: the earliest deadline). In that order: an unused quote; then a swap that ended or that the backend has (`submitted`); then a hub swap waiting for
   * the canceller's refund, which loses only its early cancel here. Never a live quote, which may be signed already,
   * nor a deposit claimed but not handed over or relayed for refund: its quote is its only record. With `quote`,
   * stores it in the same step, so two at once can't both take the last place.
   */
  reserve(keyHash: string, now: number, quote?: CachedQuote): Promise<Room>;
  get(quoteId: string): Promise<CachedQuote | undefined>;
  /** Drops a quote whose `reserve` failed: a Redis that answered too late may have stored it all the same. */
  discard(quoteId: string): Promise<void>;
  /** Atomic: of two txs claiming one quote at once, one gets `claimed` and the other `taken`. */
  claim(quoteId: string, txHash: string): Promise<"claimed" | "taken" | "gone">;
  set(quoteId: string, fields: Pick<CachedQuote, "submitRetryAt" | "submitRefused">): Promise<void>;
  /** `submitted`, unless it was handed over another way meanwhile. */
  setSubmitted(quoteId: string): Promise<void>;
  /**
   * Sets how it was handed over and keeps it until `quote.expiresAt`; puts it back if it was dropped meanwhile. A hub
   * outcome never replaces a later one (`outranked`).
   */
  handOver(quote: CachedQuote & { handedOver: HandedOver }, now: number): Promise<void>;
  /**
   * Atomic: takes the relay for refund of the quote's deposit until `until` (epoch ms), so two calls at once don't both
   * relay it. `go` (also for a quote that's gone), how it was handed over meanwhile, or when another call's relay
   * ends.
   */
  claimRelay(quoteId: string, now: number, until: number): Promise<RelayClaim>;
  /** Ends a relay that failed, so the next call tries it again. */
  releaseRelay(quoteId: string): Promise<void>;
  /** When `txHash` was first tracked for the quote: `now` the first time, `undefined` if the quote is gone. */
  trackedSince(quoteId: string, txHash: string, now: number): Promise<number | undefined>;
  open(now: number): Promise<OpenQuotes>;
  /** The open quotes without a call, for the heartbeat: memory's now, Redis's as the last sweep found them. */
  openNow(now: number): OpenQuotes | undefined;
  /** Drops the expired quotes; returns the unused ones. */
  sweep(now: number): Promise<UnusedQuote[]>;
  /** Test only. */
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The drop-off between quote and deposit (#110): a quote gone without one, expired, or evicted past its deadline
 * from a full store. Outside the request that dropped it, whose record it isn't.
 */
export function logUnused(quotes: UnusedQuote[]): void {
  for (const quote of quotes) {
    runWithRequestContext({}, () =>
      logger.info(
        {
          "quote.id": quote.quoteId,
          "quote.drop_reason": quote.reason,
          "chain.key": quote.srcChainKey,
          "dst_chain.key": quote.dstChainKey,
          "caller.key_hash": tagOf(quote.keyHash),
        },
        "Swap quote expired unused",
      ),
    );
  }
}

/** The quote's deadline in epoch ms: its intent's, which quote checked against the request's. */
export const deadlineMs = (quote: Pick<CachedQuote, "intent">) => Number(quote.intent.deadline) * 1000;

/** `REDIS_URL`: a `redis://` or `rediss://` URL, or unset. Anything else stops the server; never echoed, as it may hold a password. */
export function parseRedisUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let protocol: string | undefined;
  try {
    protocol = new URL(text).protocol;
  } catch {}
  if (protocol !== "redis:" && protocol !== "rediss:") throw new Error("REDIS_URL must be a redis:// or rediss:// URL");
  return text;
}
