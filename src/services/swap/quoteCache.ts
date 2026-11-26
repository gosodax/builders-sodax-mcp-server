/**
 * Quotes ready to sign, by `quoteId`, so the agent never retypes the intent's bigint fields and track/cancel trust
 * only what was quoted. Kept in memory, where a restart loses them (see ADR §Quote cache), or in Redis when
 * `REDIS_URL` is set (#125): `useQuoteStore`.
 *
 * A quote belongs to the API key that made it: the store is shared by every caller, so only its creator may submit,
 * relay or alert on it. A change is made in the store and on the caller's copy alike.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "../logger.js";
import { runWithRequestContext } from "../requestContext.js";
import { ActionError } from "./errors.js";
import { MemoryQuoteStore } from "./memoryQuoteStore.js";
import {
  type CachedQuote,
  HANDED_OVER_RETENTION_MS,
  type HandedOver,
  type HubOutcome,
  type QuoteStore,
  type RelayClaim,
  type Room,
  deadlineMs,
  logUnused,
} from "./quoteStore.js";

export { type CachedQuote, deadlineMs } from "./quoteStore.js";

const GRACE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// At shutdown, how long the writes the store failed get to go through: as long as one Redis call may take.
const FLUSH_MS = 2_000;

let store: QuoteStore = new MemoryQuoteStore();
let lastFullWarningAt = Number.NEGATIVE_INFINITY;
let sweepTimer: NodeJS.Timeout | undefined;
let lastSweep: Promise<void> = Promise.resolve();

/** Swaps the store, at startup. Redis may hold expired quotes already, so it's swept from now on. */
export function useQuoteStore(next: QuoteStore): void {
  stopSweeping();
  store = next;
  unwritten.clear();
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
  startSweeping();
}

export function quoteStoreKind(): QuoteStore["kind"] {
  return store.kind;
}

export async function closeQuoteStore(): Promise<void> {
  stopSweeping();
  await flushQuoteWrites();
  await store.close();
}

/**
 * One last try, at shutdown, at the writes the store failed: what's still unwritten after `FLUSH_MS` is lost with this
 * process (`quotesLostOnRestart`).
 */
export async function flushQuoteWrites(): Promise<void> {
  if (unwritten.size === 0) return;
  await Promise.race([flushAll(), sleep(FLUSH_MS, undefined, { ref: false })]);
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
  let room: Room;
  try {
    room = await store.reserve(entry.keyHash, Date.now(), entry);
  } catch (error) {
    // A call that timed out may store it all the same, and it would count toward the caps until it expires.
    if (error instanceof ActionError && error.code === "UPSTREAM_UNAVAILABLE") {
      void store.discard(entry.quoteId).catch(() => {});
    }
    throw error;
  }
  refuseIfFull(room);
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
  // Writes the store failed, for quotes no call reads again: retried here, as before a read.
  await flushAll();
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
  await flush(quoteId);
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

type Writes = { queue: (() => Promise<void>)[]; running?: Promise<void> };
// Per quote, the writes not in the store yet, in order. One runs at a time, so a later write never lands before an
// earlier one; one that fails stays first. Lost only with this process.
const unwritten = new Map<string, Writes>();

/**
 * Records what a step outside this server did (a submit, a relay, the hub's answer). That step stands whatever the
 * store does, so a store that fails here is logged, not the caller's error: told to retry, the agent would have the
 * step done twice. The write is made again before the quote is next read, so that call sees it: a deposit relayed for
 * refund has no backend row, and its quote is the only record of the relay.
 */
async function record(quoteId: string, write: (quoteId: string) => Promise<void>): Promise<void> {
  let writes = unwritten.get(quoteId);
  if (!writes) {
    writes = { queue: [] };
    unwritten.set(quoteId, writes);
  }
  writes.queue.push(() => write(quoteId));
  try {
    await flush(quoteId);
  } catch (error) {
    logger.error({ err: error, "quote.id": quoteId }, "Couldn't record a swap's progress in the quote store");
  }
}

/** Every quote's writes not in the store yet; one the store still fails stays for the next try. */
async function flushAll(): Promise<void> {
  await Promise.all([...unwritten.keys()].map(quoteId => flush(quoteId).catch(() => {})));
}

/** Makes the quote's writes not in the store yet, in order; throws while the store still fails one. */
function flush(quoteId: string): Promise<void> {
  const writes = unwritten.get(quoteId);
  if (!writes) return Promise.resolve();
  if (!writes.running) {
    const running = drain(quoteId, writes).finally(() => {
      writes.running = undefined;
    });
    writes.running = running;
  }
  return writes.running;
}

async function drain(quoteId: string, writes: Writes): Promise<void> {
  while (writes.queue.length > 0) {
    await writes.queue[0]();
    writes.queue.shift();
  }
  unwritten.delete(quoteId);
}

export async function markSubmitFailed(quote: CachedQuote, waitSec: number): Promise<void> {
  const at = Date.now() + waitSec * 1000;
  quote.submitRetryAt = at;
  await record(quote.quoteId, id => store.set(id, { submitRetryAt: at }));
}

/** Unless the hub settled it while the submit ran: a cancel confirmed meanwhile stands. */
export async function markSubmitted(quote: CachedQuote): Promise<void> {
  quote.handedOver ??= "submitted";
  await record(quote.quoteId, id => store.setSubmitted(id));
}

export async function markSubmitRefused(quote: CachedQuote): Promise<void> {
  quote.submitRefused = true;
  await record(quote.quoteId, id => store.set(id, { submitRefused: true }));
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
  // Put back if it was dropped while a read or the relay ran.
  const handedOver = { ...quote, handedOver: how };
  await record(quote.quoteId, () => store.handOver(handedOver, now));
}

/**
 * Takes the relay for refund of the quote's deposit until `until` (epoch ms), so track and cancel, or two servers,
 * don't both relay it: `go`, how it was handed over since the caller read it, or when another call's relay ends.
 */
export async function claimRefundRelay(quote: CachedQuote, until: number): Promise<RelayClaim> {
  await flush(quote.quoteId);
  const claim = await store.claimRelay(quote.quoteId, Date.now(), until).catch(error => {
    // A claim that timed out may still be taken: taken back, it doesn't hold the refund for its whole term. Redis runs
    // one connection's calls in order, so the release comes after it.
    store.releaseRelay(quote.quoteId, until).catch(() => {});
    throw error;
  });
  if (typeof claim === "string" && claim !== "go") quote.handedOver = claim;
  return claim;
}

/**
 * A relay that failed: the next call tries again. `until` is the claim's, so only that claim ends. Best-effort, as
 * the claim lapses by itself.
 */
export async function releaseRefundRelay(quote: CachedQuote, until: number): Promise<void> {
  await store.releaseRelay(quote.quoteId, until).catch(() => {});
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

/** For the heartbeat, which can't wait: in Redis, what the last read found (a sweep's or `/health`'s), `undefined` before one or after a failed one. */
export function openQuoteCount(): number | undefined {
  return store.openNow(Date.now())?.open;
}

/**
 * What a restart would lose now, for the stop and crash alerts: in memory, the open quotes; in Redis, the writes it
 * never received, which may get a relay for refund repeated. `undefined` if nothing.
 */
export function quotesLostOnRestart(): string | undefined {
  if (store.kind === "redis") {
    const n = unwritten.size;
    return n > 0
      ? `${n} swap quote(s) with updates Redis never received; a relay for refund may be repeated`
      : undefined;
  }
  const open = openQuoteCount() ?? 0;
  return open > 0
    ? `${open} open swap quote(s) lost. A deposit made from one alerts as "Swap deposit without its quote"`
    : undefined;
}

/** Test only. */
export async function clearQuoteCache(): Promise<void> {
  unwritten.clear();
  await store.clear();
  lastFullWarningAt = Number.NEGATIVE_INFINITY;
}
