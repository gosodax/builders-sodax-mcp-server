import { randomUUID } from "node:crypto";
import { ErrorReply, createClient } from "@redis/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { getRequestContext, runWithRequestContext } from "../requestContext.js";
import { REDIS_URLS, openRedisStore, redisServers } from "./__fixtures__/redis.js";
import { ActionError } from "./errors.js";
import { MemoryQuoteStore } from "./memoryQuoteStore.js";
import {
  type CachedQuote,
  checkQuoteRoom,
  claimDeposit,
  clearQuoteCache,
  closeQuoteStore,
  getCachedQuote,
  markHubOutcome,
  markRelayedForRefund,
  markSubmitted,
  openQuotes,
  putQuote,
  quotesLostOnRestart,
  sweepDone,
  useQuoteStore,
} from "./quoteCache.js";
import type { QuoteStore } from "./quoteStore.js";
import { RedisQuoteStore, connectRedisQuoteStore } from "./redisQuoteStore.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const KEY = "a".repeat(64);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// The same tests run against Redis when there's one to test (__fixtures__/redis.ts).
const STORES: { kind: QuoteStore["kind"]; open: () => Promise<QuoteStore> }[] = [
  { kind: "memory", open: async () => new MemoryQuoteStore() },
  ...REDIS_URLS.map(url => ({ kind: "redis" as const, open: () => openRedisStore(url) })),
];

/** A quote whose deadline is `minutes` from NOW. */
function quoteDue(minutes: number, keyHash = KEY) {
  const deadline = String(Math.floor(NOW / 1000) + minutes * 60);
  return putQuote({
    srcChainKey: "0xa4b1.arbitrum",
    dstChainKey: "sonic",
    srcAddress: "0x000000000000000000000000000000000000dEaD",
    dstAddress: "0x000000000000000000000000000000000000dEaD",
    inputToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    outputToken: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    inputAmount: 5000000n,
    minOutputAmount: 4941968n,
    deadline,
    intent: {
      intentId: "1",
      creator: `0x${"c".repeat(40)}`,
      srcChain: "23",
      dstChain: "146",
      inputToken: "0xdB7BdA65c3a1C51D64dC4444e418684677334109",
      outputToken: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
      inputAmount: "5000000",
      minOutputAmount: "4941968",
      deadline,
      allowPartialFill: false,
      srcAddress: "0x000000000000000000000000000000000000dEaD",
      dstAddress: "0x000000000000000000000000000000000000dEaD",
      solver: `0x${"0".repeat(40)}`,
      data: "0x",
    },
    relayData: { address: "0x000000000000000000000000000000000000dEaD", payload: "0x01" },
    keyHash,
    minimumReceived: { amount: "4.941968", symbol: "USDC", chainName: "Sonic" },
  });
}

/** `count` quotes put a batch at a time: the order between them doesn't matter, and Redis answers faster so. */
async function quotesDue(count: number, minutes: number, keyHash: (i: number) => string) {
  const put: CachedQuote[] = [];
  for (let from = 0; from < count; from += 500) {
    const batch = Array.from({ length: Math.min(500, count - from) }, (_, i) => quoteDue(minutes, keyHash(from + i)));
    put.push(...(await Promise.all(batch)));
  }
  return put;
}

/** What `put` threw. */
const refusal = (put: Promise<unknown>) =>
  put.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Moves the clock on, firing the sweeps due on the way, and waits for the last of them. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await sweepDone();
}

describe.each(STORES)("quoteCache in $kind", ({ open }) => {
  let store: QuoteStore;

  beforeAll(async () => {
    store = await open();
  });

  afterAll(async () => {
    await store.clear();
    await store.close();
    useQuoteStore(new MemoryQuoteStore());
  });

  beforeEach(async () => {
    // Real timeouts, so the Redis client and its call timeout run as usual; the sweep's interval is driven by hand.
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
    useQuoteStore(store);
    await clearQuoteCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a quote until 30 minutes past its deadline", async () => {
    const { quoteId } = await quoteDue(15);
    vi.setSystemTime(NOW + 44 * MINUTE);
    expect((await getCachedQuote(quoteId, KEY)) as CachedQuote).toMatchObject({ quoteId, inputAmount: 5000000n });
    vi.setSystemTime(NOW + 45 * MINUTE);
    expect(await getCachedQuote(quoteId, KEY)).toBeUndefined();
  });

  it("records each quote that expires without a deposit within a minute, outside the request that started the sweep", async () => {
    const unused = await runWithRequestContext({ requestId: "first-quote" }, () => quoteDue(15));
    await claimDeposit(await quoteDue(15), "0x01");
    const seen: (string | undefined)[] = [];
    const info = vi.spyOn(logger, "info").mockImplementation((() => {
      seen.push(getRequestContext().requestId);
    }) as never);
    // Expiry is 30 minutes past the deadline; the sweep runs once a minute.
    await advance(45 * MINUTE - 1);
    expect(info).not.toHaveBeenCalled();
    await advance(MINUTE);
    expect(info.mock.calls).toEqual([
      [
        {
          "quote.id": unused.quoteId,
          "quote.drop_reason": "expired",
          "chain.key": "0xa4b1.arbitrum",
          "dst_chain.key": "sonic",
          "caller.key_hash": KEY.slice(0, 16),
        },
        "Swap quote expired unused",
      ],
    ]);
    expect(seen).toEqual([undefined]);
  });

  it("leaves an expired quote to the sweep: a lookup finds nothing and writes no record of its own", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { quoteId } = await quoteDue(15);
    vi.setSystemTime(NOW + 45 * MINUTE);
    expect(await getCachedQuote(quoteId, KEY)).toBeUndefined();
    expect(await getCachedQuote(quoteId, "b".repeat(64))).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
    await advance(MINUTE);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("serves a quote only to the key that made it, and says so to another", async () => {
    const { quoteId } = await quoteDue(15);
    expect(await getCachedQuote(quoteId, "b".repeat(64))).toBe("key_mismatch");
    expect(await getCachedQuote(quoteId, KEY)).toMatchObject({ quoteId });
  });

  it("gives a quote to its first checked deposit for good, and records how it was handed over", async () => {
    const quote = await quoteDue(15);
    const { quoteId } = quote;
    expect(await claimDeposit(quote, "0x01")).toBe("claimed");
    expect(await claimDeposit(quote, "0x02")).toBe("taken");
    expect(await claimDeposit(quote, "0x01")).toBe("claimed");
    expect(await getCachedQuote(quoteId, KEY)).toMatchObject({ depositTxHash: "0x01" });
    expect(await getCachedQuote(quoteId, KEY)).not.toHaveProperty("handedOver");
    await markSubmitted(quote);
    expect(await getCachedQuote(quoteId, KEY)).toMatchObject({ depositTxHash: "0x01", handedOver: "submitted" });
    expect(await claimDeposit({ ...quote, quoteId: randomUUID() }, "0x01")).toBe("gone");
  });

  it("gives a quote claimed by two txs at once to exactly one of them", async () => {
    const quote = await quoteDue(15);
    const claims = await Promise.all([claimDeposit({ ...quote }, "0x01"), claimDeposit({ ...quote }, "0x02")]);
    expect(claims.sort()).toEqual(["claimed", "taken"]);
  });

  it("keeps a relayed quote for a day, its only record of the refund, even one dropped while it was relayed", async () => {
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0xaa");
    await markRelayedForRefund(quote);
    vi.setSystemTime(NOW + 23 * 60 * MINUTE);
    expect(await getCachedQuote(quote.quoteId, KEY)).toMatchObject({
      depositTxHash: "0xaa",
      handedOver: "relayed_for_refund",
    });

    const dropped = await quoteDue(15);
    await claimDeposit(dropped, "0xbb");
    await clearQuoteCache();
    await markRelayedForRefund(dropped);
    expect(await getCachedQuote(dropped.quoteId, KEY)).toMatchObject({
      depositTxHash: "0xbb",
      handedOver: "relayed_for_refund",
    });
    // Put back into an empty store, it's still swept once its day is over.
    await advance(DAY + MINUTE);
    expect(await getCachedQuote(dropped.quoteId, KEY)).toBeUndefined();
  });

  it("keeps a cancel the hub confirmed while the submit ran: submitted doesn't overwrite it", async () => {
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0x01");
    // The copy track read before the cancel was confirmed.
    const submitting = { ...quote };
    await markHubOutcome(quote, "cancelled");
    await markSubmitted(submitting);
    expect(await getCachedQuote(quote.quoteId, KEY)).toMatchObject({ handedOver: "cancelled" });
  });

  it("keeps a hub swap's later outcome over an earlier one written late, as another server's replay is", async () => {
    const outcome = async (quote: CachedQuote) =>
      ((await getCachedQuote(quote.quoteId, KEY)) as CachedQuote).handedOver;
    const late = await quoteDue(15);
    await claimDeposit(late, "0x01");
    await markHubOutcome({ ...late }, "cancelled");
    await markHubOutcome({ ...late }, "closed");
    await markHubOutcome({ ...late }, "left_to_refund");
    expect(await outcome(late)).toBe("cancelled");
    // In the order they happen, each one stands.
    const inOrder = await quoteDue(15);
    await claimDeposit(inOrder, "0x02");
    for (const how of ["left_to_refund", "closed", "cancelled"] as const) {
      await markHubOutcome({ ...inOrder }, how);
      expect(await outcome(inOrder)).toBe(how);
    }
  });

  it("makes each write the store failed once, in order, before the next read, even two reads at once", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0x01");
    const down = new Error("store down");
    const setSubmitted = vi.spyOn(store, "setSubmitted").mockRejectedValueOnce(down).mockRejectedValueOnce(down);
    const handOver = vi.spyOn(store, "handOver");
    await markSubmitted({ ...quote });
    await markRelayedForRefund({ ...quote });
    expect(handOver).not.toHaveBeenCalled();
    const reads = await Promise.all([getCachedQuote(quote.quoteId, KEY), getCachedQuote(quote.quoteId, KEY)]);
    expect(reads).toMatchObject([{ handedOver: "relayed_for_refund" }, { handedOver: "relayed_for_refund" }]);
    expect(setSubmitted).toHaveBeenCalledTimes(3);
    expect(handOver).toHaveBeenCalledTimes(1);
  });

  it("never makes a write the store failed after a later one", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0x01");
    let timeOut = (_error: Error) => {};
    vi.spyOn(store, "handOver").mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          timeOut = reject;
        }),
    );
    const refund = markHubOutcome({ ...quote }, "left_to_refund");
    const cancel = markHubOutcome({ ...quote }, "cancelled");
    timeOut(new Error("No reply within 2000 ms"));
    await Promise.all([refund, cancel]);
    expect(await getCachedQuote(quote.quoteId, KEY)).toMatchObject({ handedOver: "cancelled" });
  });

  it("makes a write the store failed in the next sweep, for a quote no call reads again", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0x01");
    vi.spyOn(store, "handOver").mockRejectedValueOnce(new Error("store down"));
    await markRelayedForRefund({ ...quote });
    expect((await store.get(quote.quoteId))?.handedOver).toBeUndefined();
    await advance(MINUTE);
    expect((await store.get(quote.quoteId))?.handedOver).toBe("relayed_for_refund");
  });

  it("drops a quote whose put timed out, which a Redis that answered late may have stored", async () => {
    const reserve = store.reserve.bind(store);
    vi.spyOn(store, "reserve").mockImplementationOnce(async (...args) => {
      await reserve(...args);
      throw new ActionError("UPSTREAM_UNAVAILABLE", "This server can't reach its swap quote store right now.");
    });
    await expect(quoteDue(15)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await new Promise(resolve => setImmediate(resolve));
    expect(await openQuotes()).toMatchObject({ open: 0 });
  });

  it("lets one call at a time relay a deposit for refund, until its relay ends or its claim lapses", async () => {
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0x01");
    const claim = (now: number) => store.claimRelay(quote.quoteId, now, now + 30_000);
    expect(await claim(NOW)).toBe("go");
    expect(await claim(NOW + 1_000)).toEqual({ busyUntil: NOW + 30_000 });
    await store.releaseRelay(quote.quoteId);
    expect(await claim(NOW + 2_000)).toBe("go");
    expect(await claim(NOW + 32_001)).toBe("go");
    await markRelayedForRefund(quote);
    expect(await claim(NOW + 70_000)).toBe("relayed_for_refund");
    expect(await store.claimRelay(randomUUID(), NOW, NOW + 30_000)).toBe("go");
  });

  it("counts a quote handed over without a claim (put back after a cancel) as unused once it expires", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const quote = await quoteDue(15);
    await markHubOutcome(quote, "cancelled");
    await advance(DAY + MINUTE);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ "quote.id": quote.quoteId }),
      "Swap quote expired unused",
    );
  });

  it("returns nothing for an unknown id", async () => {
    expect(await getCachedQuote(randomUUID(), KEY)).toBeUndefined();
  });

  it("when full, drops an expired quote, an unclaimed one past its deadline, then a hub swap the hub holds, never a live or other claimed one", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const live = await quoteDue(15);
    const expired = await quoteDue(-31);
    const pastDeadline = await quoteDue(-1);
    const claimed = await quoteDue(-2);
    await claimDeposit(claimed, "0x01");
    const relayed = await quoteDue(-3);
    await claimDeposit(relayed, "0x02");
    await markRelayedForRefund(relayed);
    const leftToRefund = await quoteDue(-4);
    await claimDeposit(leftToRefund, "0x03");
    await markHubOutcome(leftToRefund, "left_to_refund");
    const cancelled = await quoteDue(-5);
    await claimDeposit(cancelled, "0x04");
    await markHubOutcome(cancelled, "cancelled");
    await quotesDue(9_993, 15, i => `key-${i % 20}`);

    // Full, within a minute of the last sweep: the expired quote goes first.
    const next = await quoteDue(15);
    expect(await getCachedQuote(expired.quoteId, KEY)).toBeUndefined();
    expect(await getCachedQuote(pastDeadline.quoteId, KEY)).toBeDefined();

    await quoteDue(15);
    expect(await getCachedQuote(pastDeadline.quoteId, KEY)).toBeUndefined();
    expect(await getCachedQuote(leftToRefund.quoteId, KEY)).toBeDefined();

    // Then a swap that ended, though newer; then one waiting for its refund, which only loses its early cancel here.
    // A relayed deposit's quote is its only record, so it stays.
    await quoteDue(15);
    expect(await getCachedQuote(cancelled.quoteId, KEY)).toBeUndefined();
    expect(await getCachedQuote(leftToRefund.quoteId, KEY)).toBeDefined();
    await quoteDue(15);
    expect(await getCachedQuote(leftToRefund.quoteId, KEY)).toBeUndefined();

    // Nothing left that can go: new quotes wait, before any is built.
    await expect(quoteDue(15)).rejects.toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSec: 60 } });
    await expect(checkQuoteRoom("c".repeat(64))).rejects.toThrow("too many open swap quotes");
    for (const kept of [live, claimed, relayed, next]) expect(await getCachedQuote(kept.quoteId, KEY)).toBeDefined();
    const dropped = info.mock.calls
      .filter(([, msg]) => msg === "Swap quote expired unused")
      .map(([fields]) => [
        (fields as Record<string, string>)["quote.id"],
        (fields as Record<string, string>)["quote.drop_reason"],
      ]);
    expect(dropped).toEqual([
      [expired.quoteId, "expired"],
      [pastDeadline.quoteId, "evicted"],
    ]);
  }, 60_000);

  it("makes a key with 1,000 open quotes wait until one leaves the store, never dropping another key's", async () => {
    const other = await quoteDue(15, "b".repeat(64));
    await quotesDue(1_000, 15, () => KEY);
    const refused = await refusal(quoteDue(15));
    // A quote is kept 30 minutes past its deadline, so it counts until then.
    expect(refused).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSec: 45 * 60 } });
    await expect(checkQuoteRoom(KEY)).rejects.toThrow(refused as Error);
    expect(await getCachedQuote(other.quoteId, "b".repeat(64))).toMatchObject({ quoteId: other.quoteId });

    vi.setSystemTime(NOW + 15 * MINUTE);
    await expect(checkQuoteRoom(KEY)).rejects.toThrow("too many open swap quotes");
    vi.setSystemTime(NOW + 45 * MINUTE);
    expect((await quoteDue(15)).quoteId).toEqual(expect.any(String));
  }, 30_000);

  it("counts as open, for /health, every quote not handed over and not expired, until the last one expires", async () => {
    expect(await openQuotes()).toEqual({ open: 0, openUntil: null });
    await quoteDue(15);
    const late = await quoteDue(20);
    await claimDeposit(await quoteDue(10), "0x01"); // claimed, not yet submitted: in memory a restart still loses it
    const submitted = await quoteDue(25);
    await markSubmitted(submitted);
    await markRelayedForRefund(await quoteDue(25));
    expect(await openQuotes()).toEqual({ open: 3, openUntil: new Date(late.expiresAt).toISOString() });
    vi.setSystemTime(late.expiresAt);
    expect(await openQuotes()).toEqual({ open: 0, openUntil: null });
  });

  it("doesn't count a quote a deposit claimed toward its key's cap", async () => {
    const [first] = await quotesDue(1_000, 15, () => KEY);
    await expect(checkQuoteRoom(KEY)).rejects.toThrow("too many open swap quotes");
    await claimDeposit(first, "0x01");
    await expect(quoteDue(15)).resolves.toBeDefined();
  }, 30_000);
});

describe.each(REDIS_URLS)("quoteCache in Redis, across servers", url => {
  const { prefix, open, closeAll } = redisServers(url);
  const raw = createClient({ url });

  beforeAll(async () => {
    await raw.connect();
  });

  afterAll(async () => {
    await closeAll();
    await raw.close();
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a quote, its claim and its hand-over across a restart", async () => {
    const first = await open();
    useQuoteStore(first);
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0x01");
    await markHubOutcome(quote, "left_to_refund");
    await first.close();

    useQuoteStore(await open());
    expect(await getCachedQuote(quote.quoteId, KEY)).toEqual(quote);
  });

  it("gives a quote two servers claim at once to exactly one of them", async () => {
    const [one, two] = [await open(), await open()];
    useQuoteStore(one);
    const quote = await quoteDue(15);
    const claims = await Promise.all([one.claim(quote.quoteId, "0x01"), two.claim(quote.quoteId, "0x02")]);
    expect(claims.sort()).toEqual(["claimed", "taken"]);
  });

  it("has Redis drop a quote shortly after it expires, and a handed-over one a day on", async () => {
    useQuoteStore(await open());
    const quote = await quoteDue(15);
    const ttl = () => raw.pTTL(`${prefix}q:${quote.quoteId}`);
    // An hour past expiry, so a sweep after an outage can still record it if unused.
    expect(await ttl()).toBeGreaterThan(105 * MINUTE - 5_000);
    expect(await ttl()).toBeLessThanOrEqual(105 * MINUTE);
    await claimDeposit(quote, "0x01");
    await markRelayedForRefund(quote);
    expect(await ttl()).toBeGreaterThan(DAY + 60 * MINUTE - 5_000);
  });

  it("makes the writes Redis missed before it closes, so the next server has them", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const first = await open();
    useQuoteStore(first);
    const quote = await quoteDue(15);
    await claimDeposit(quote, "0x01");
    vi.spyOn(first, "handOver").mockRejectedValueOnce(new Error("No reply within 2000 ms"));
    await markRelayedForRefund(quote);
    expect(quotesLostOnRestart()).toBeDefined();
    await closeQuoteStore();
    expect(quotesLostOnRestart()).toBeUndefined();
    useQuoteStore(await open());
    expect(await getCachedQuote(quote.quoteId, KEY)).toMatchObject({ handedOver: "relayed_for_refund" });
    error.mockRestore();
  });

  it("calls an error Redis answers with a fault, not an outage: logged each time, and alerted", async () => {
    useQuoteStore(await open());
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    // Another writer left a key of another type where an index goes.
    await raw.set(`${prefix}all`, "not a sorted set");
    await expect(quoteDue(15)).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(checkQuoteRoom(KEY)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(error).toHaveBeenCalledTimes(2);
    await raw.del(`${prefix}all`);
  });
});

// Needs no Redis: nothing listens on port 1.
describe("quoteCache with Redis unreachable", () => {
  let down: QuoteStore;

  beforeAll(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    down = connectRedisQuoteStore("redis://127.0.0.1:1", `test:${randomUUID()}:`);
    useQuoteStore(down);
  });

  afterAll(async () => {
    await down.close();
    useQuoteStore(new MemoryQuoteStore());
    vi.restoreAllMocks();
  });

  it("refuses new quotes and fails a lookup as retryable, never falling back to memory", async () => {
    const unreachable = { code: "UPSTREAM_UNAVAILABLE", details: { retryAfterSec: 30 } };
    await expect(checkQuoteRoom(KEY)).rejects.toMatchObject(unreachable);
    await expect(quoteDue(15)).rejects.toMatchObject(unreachable);
    await expect(getCachedQuote(randomUUID(), KEY)).rejects.toMatchObject(unreachable);
    await expect(openQuotes()).rejects.toMatchObject(unreachable);
  });

  it("says a restart loses the progress Redis never received, and nothing once there's none", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(quotesLostOnRestart()).toBeUndefined();
    await markSubmitted({ quoteId: randomUUID() } as CachedQuote);
    expect(quotesLostOnRestart()).toBe(
      "1 swap quote update(s) Redis never received; a relay for refund may be repeated",
    );
    await clearQuoteCache().catch(() => {});
  });

  it("starts without a Redis that's down: its first connect is waited for only so long", async () => {
    await expect((down as RedisQuoteStore).ready(50)).resolves.toBeUndefined();
  });
});

describe("quoteCache on a Redis that answers with an error", () => {
  it.each([
    [
      "is loading its data: an outage that passes",
      "LOADING Redis is loading the dataset in memory",
      "UPSTREAM_UNAVAILABLE",
    ],
    ["is out of memory: a fault, alerted", "OOM command not allowed when used memory > 'maxmemory'.", "INTERNAL"],
  ])("calls one that %s", async (_case, reply, code) => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const client = { isReady: true, eval: vi.fn().mockRejectedValue(new ErrorReply(reply)) };
    const store = new RedisQuoteStore(client as never, "test:");
    await expect(store.open(Date.now())).rejects.toMatchObject({ code });
    expect(store.openNow()).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("still logs the quotes a sweep dropped when its reply comes after the call timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    let answer = (_reply: string[]) => {};
    const reply = new Promise<string[]>(resolve => {
      answer = resolve;
    });
    const store = new RedisQuoteStore({ isReady: true, eval: () => reply } as never, "test:");
    const swept = expect(store.sweep(Date.now())).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(2_000);
    await swept;
    answer(["0", "0", "late", "expired", KEY, "0xa4b1.arbitrum", "sonic"]);
    await new Promise(resolve => setImmediate(resolve));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ "quote.id": "late", "quote.drop_reason": "expired" }),
      "Swap quote expired unused",
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
