/**
 * Quotes ready to sign, by `quoteId`, so the agent never retypes the intent's bigint fields and track/cancel trust
 * only what was quoted. Kept in memory, where a restart loses them (see ADR §Quote cache), or in Redis when
 * `REDIS_URL` is set (#125): `useQuoteStore`.
 *
 * A quote belongs to the API key that made it: the store is shared by every caller, so only its creator may submit,
 * relay or alert on it. A change is made in the store and on the caller's copy alike.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { runWithRequestContext, tagOf } from "../requestContext.js";
import { ActionError } from "./errors.js";
import { MemoryQuoteStore } from "./memoryQuoteStore.js";
import {
  type CachedQuote,
  type HandedOver,
  type HubOutcome,
  type QuoteStore,
  type Room,
  type UnusedQuote,
  deadlineMs,
} from "./quoteStore.js";

export type { CachedQuote } from "./quoteStore.js";

const GRACE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// With no backend row, the quote is the only record of what became of the swap.
const HANDED_OVER_RETENTION_MS = 24 * 60 * 60 * 1000;

let store: QuoteStore = new MemoryQuoteStore();
let lastFullWarningAt = Number.NEGATIVE_INFINITY;
let sweepTimer: NodeJS.Timeout | undefined;
let lastSweep: Promise<void> = Promise.resolve();

/** Swaps the store, at startup. Redis may hold expired quotes already, so it's swept from now on. */
export function useQuoteStore(next: QuoteStore): void {
  stopSweeping();
  store = next;
  leftOver.clear();
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
  startSweeping();
}

export function quoteStoreKind(): QuoteStore["kind"] {
  return store.kind;
}

export async function closeQuoteStore(): Promise<void> {
  stopSweeping();
  await store.close();
}

/**
 * Refuses a key with too many open quotes, or any key while the store is full of quotes it can't drop;
 * checked before a quote is built, and again when it's put.
 */
export async function checkQuoteRoom(keyHash: string): Promise<void> {
  refuseIfFull(await store.reserve(keyHash, Date.now()));
}

export async function putQuote(quote: Omit<CachedQuote, "quoteId" | "expiresAt">): Promise<CachedQuote> {
  const entry = { ...quote, quoteId: randomUUID(), expiresAt: deadlineMs(quote) + GRACE_MS };
  refuseIfFull(await store.reserve(entry.keyHash, Date.now(), entry));
  startSweeping();
  return entry;
}

function refuseIfFull(room: Room): void {
  logUnused(room.unused);
  if (room.full === "key") {
    throw new ActionError("RATE_LIMITED", "This API key has too many open swap quotes.", {
      nextStep:
        "Wait retryAfterSec seconds for a quote to expire, then try again. To watch a price meanwhile, use sodax_swap_price, which holds none.",
      details: { retryAfterSec: Math.ceil((room.retryAt - Date.now()) / 1000) },
    });
  }
  if (room.full === "store") {
    const now = Date.now();
    if (now - lastFullWarningAt >= SWEEP_INTERVAL_MS) {
      lastFullWarningAt = now;
      logger.warn("The quote store is full of live and claimed quotes; refusing new ones");
    }
    throw new ActionError("RATE_LIMITED", "This server holds too many open swap quotes right now.", {
      nextStep: "Wait retryAfterSec seconds, then try again. sodax_swap_price still works meanwhile: it holds none.",
      details: { retryAfterSec: SWEEP_INTERVAL_MS / 1000 },
    });
  }
}

/**
 * The drop-off between quote and deposit (#110): a quote gone without one, expired, or evicted past its deadline
 * from a full store. Outside the request that dropped it, whose record it isn't.
 */
function logUnused(quotes: UnusedQuote[]): void {
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

/**
 * Deadlines differ, so age order isn't expiry order: expired quotes go in a sweep once a minute, which records an
 * unused one near its expiry. From the first quote, or from startup with a store set.
 */
function startSweeping(): void {
  // Created outside any request, so its runs don't carry the one that started it.
  sweepTimer ??= runWithRequestContext({}, () =>
    setInterval(() => {
      lastSweep = sweep();
    }, SWEEP_INTERVAL_MS).unref(),
  );
}

async function sweep(): Promise<void> {
  const now = Date.now();
  try {
    logUnused(await store.sweep(now));
  } catch {
    // Unreachable: the store logged it, and the next sweep tries again.
  }
}

function stopSweeping(): void {
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/** Test only: the sweep a timer started, finished. */
export function sweepDone(): Promise<void> {
  return lastSweep;
}

/** The quote, `undefined` if it's gone or expired (the sweep drops it), or `"key_mismatch"` if another key made it. */
export async function getCachedQuote(
  quoteId: string,
  keyHash: string,
): Promise<CachedQuote | "key_mismatch" | undefined> {
  await recordLeftOver(quoteId);
  const quote = await store.get(quoteId);
  if (!quote || quote.expiresAt <= Date.now()) return undefined;
  return quote.keyHash === keyHash ? quote : "key_mismatch";
}

/**
 * Claims the quote for a checked deposit, atomically, so a second tx tracked at the same time sees the claim.
 * `taken` if another deposit took it first, `gone` if the quote was dropped meanwhile.
 */
export async function claimDeposit(quote: CachedQuote, txHash: string): Promise<"claimed" | "taken" | "gone"> {
  const claim = await store.claim(quote.quoteId, txHash);
  if (claim === "claimed") quote.depositTxHash = txHash;
  return claim;
}

// Writes the store failed, by quoteId, in order: made before the quote is next read. Lost only with this process.
const leftOver = new Map<string, (() => Promise<void>)[]>();

/**
 * Records what a step outside this server did (a submit, a relay, the hub's answer). That step stands whatever the
 * store does, so a store that fails here is logged, not the caller's error: told to retry, the agent would have the
 * step done twice. The write is made again before the quote is next read, so that call sees it: a deposit relayed for
 * refund has no backend row, and its quote is the only record of the relay.
 */
async function record(quote: CachedQuote, write: () => Promise<void>): Promise<void> {
  const waiting = leftOver.get(quote.quoteId);
  if (waiting) {
    waiting.push(write);
    return;
  }
  try {
    await write();
  } catch (error) {
    leftOver.set(quote.quoteId, [write]);
    logger.error({ err: error, "quote.id": quote.quoteId }, "Couldn't record a swap's progress in the quote store");
  }
}

/** The writes left over for this quote, in order; throws while the store still fails them. */
async function recordLeftOver(quoteId: string): Promise<void> {
  const waiting = leftOver.get(quoteId);
  while (waiting?.length) {
    await waiting[0]();
    waiting.shift();
  }
  leftOver.delete(quoteId);
}

export async function markSubmitFailed(quote: CachedQuote, waitSec: number): Promise<void> {
  const at = Date.now() + waitSec * 1000;
  quote.submitRetryAt = at;
  await record(quote, () => store.set(quote.quoteId, { submitRetryAt: at }));
}

/** Unless the hub settled it while the submit ran: a cancel confirmed meanwhile stands. */
export async function markSubmitted(quote: CachedQuote): Promise<void> {
  quote.handedOver ??= "submitted";
  await record(quote, () => store.setSubmitted(quote.quoteId));
}

export async function markSubmitRefused(quote: CachedQuote): Promise<void> {
  quote.submitRefused = true;
  await record(quote, () => store.set(quote.quoteId, { submitRefused: true }));
}

export function markRelayedForRefund(quote: CachedQuote): Promise<void> {
  return markHandedOver(quote, "relayed_for_refund");
}

/**
 * A hub swap never submitted: past its deadline, left to the backend's canceller (`left_to_refund`); cancelled by
 * its user (`cancelled`); or found closed on the hub, filled or cancelled elsewhere (`closed`).
 */
export function markHubOutcome(quote: CachedQuote, how: HubOutcome): Promise<void> {
  return markHandedOver(quote, how);
}

async function markHandedOver(quote: CachedQuote, how: HandedOver): Promise<void> {
  const now = Date.now();
  quote.handedOver = how;
  quote.expiresAt = Math.max(quote.expiresAt, now + HANDED_OVER_RETENTION_MS);
  // Put back if it was dropped while a read or the relay ran, and swept again from then on.
  const handedOver = { ...quote, handedOver: how };
  await record(quote, () => store.handOver(handedOver, now));
  startSweeping();
}

/** Since when track has been called for this quote with `txHash`: now, the first time. */
export async function trackedSince(quote: CachedQuote, txHash: string): Promise<number> {
  if (quote.trackedSince?.txHash === txHash) return quote.trackedSince.at;
  const now = Date.now();
  const at = (await store.trackedSince(quote.quoteId, txHash, now)) ?? now;
  quote.trackedSince = { txHash, at };
  return at;
}

/**
 * The quotes whose deposit hasn't reached the backend yet: not handed over, not expired. In memory a restart loses
 * them, so `/health` shows them for a deploy to wait until `open` is 0 or `openUntil` has passed.
 */
export async function openQuotes(now = Date.now()): Promise<{ open: number; openUntil: string | null }> {
  return toOpen(await store.open(now));
}

const toOpen = ({ open, until }: { open: number; until: number }) => ({
  open,
  openUntil: open > 0 ? new Date(until).toISOString() : null,
});

/** For the heartbeat, which can't wait: in Redis, what the last sweep found, `undefined` before one. */
export function openQuoteCount(): number | undefined {
  return store.openNow(Date.now())?.open;
}

/** What a restart would lose now: the open quotes in memory, none in Redis. For the stop and crash alerts. */
export function quotesLostOnRestart(): number {
  return store.kind === "redis" ? 0 : (store.openNow(Date.now())?.open ?? 0);
}

/** Test only. */
export async function clearQuoteCache(): Promise<void> {
  leftOver.clear();
  await store.clear();
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
}
