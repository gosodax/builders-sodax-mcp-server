import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { getRequestContext, runWithRequestContext } from "../requestContext.js";
import { holdForTrack } from "../signWindow.js";
import {
  checkQuoteRoom,
  claimDeposit,
  clearQuoteCache,
  getCachedQuote,
  markHubOutcome,
  markRelayedForRefund,
  markSubmitted,
  openQuotes,
  putQuote,
} from "./quoteCache.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const KEY = "a".repeat(64);

/** A quote whose deadline is `minutes` from now. */
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

/** What `put` threw. */
function refusal(put: () => unknown): unknown {
  try {
    put();
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  clearQuoteCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("quoteCache", () => {
  it("keeps a quote until 30 minutes past its deadline", () => {
    const { quoteId } = quoteDue(15);
    vi.setSystemTime(NOW + 44 * 60_000);
    expect(getCachedQuote(quoteId, KEY)?.quoteId).toBe(quoteId);
    vi.setSystemTime(NOW + 45 * 60_000);
    expect(getCachedQuote(quoteId, KEY)).toBeUndefined();
  });

  it("records each quote that expires without a deposit within a minute, outside the request that started the sweep", () => {
    const unused = runWithRequestContext({ requestId: "first-quote" }, () => quoteDue(15));
    const deposited = quoteDue(15);
    claimDeposit(deposited.quoteId, "0x01");
    const seen: (string | undefined)[] = [];
    const info = vi.spyOn(logger, "info").mockImplementation((() => {
      seen.push(getRequestContext().requestId);
    }) as never);
    // Expiry is 30 minutes past the deadline; the sweep runs once a minute.
    vi.advanceTimersByTime(45 * 60_000 - 1);
    expect(info).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
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

  it("leaves an expired quote to the sweep: a lookup finds nothing and writes no record of its own", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { quoteId } = quoteDue(15);
    vi.setSystemTime(NOW + 45 * 60_000);
    expect(getCachedQuote(quoteId, KEY)).toBeUndefined();
    expect(getCachedQuote(quoteId, "b".repeat(64))).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("serves a quote only to the key that made it, and says so to another", () => {
    const { quoteId } = quoteDue(15);
    expect(getCachedQuote(quoteId, "b".repeat(64))).toBe("key_mismatch");
    expect(getCachedQuote(quoteId, KEY)).toMatchObject({ quoteId });
  });

  it("gives a quote to its first checked deposit for good, and records how it was handed over", () => {
    const { quoteId } = quoteDue(15);
    expect(claimDeposit(quoteId, "0x01")).toBe("claimed");
    expect(claimDeposit(quoteId, "0x02")).toBe("taken");
    expect(claimDeposit(quoteId, "0x01")).toBe("claimed");
    expect(getCachedQuote(quoteId, KEY)).toMatchObject({ depositTxHash: "0x01" });
    expect(getCachedQuote(quoteId, KEY)).not.toHaveProperty("handedOver");
    markSubmitted(quoteId);
    expect(getCachedQuote(quoteId, KEY)).toMatchObject({ depositTxHash: "0x01", handedOver: "submitted" });
    expect(claimDeposit("not-a-quote", "0x01")).toBe("gone");
  });

  it("keeps a relayed quote for a day, its only record of the refund, even one dropped while it was relayed", () => {
    const quote = quoteDue(15);
    claimDeposit(quote.quoteId, "0xaa");
    markRelayedForRefund(quote);
    vi.setSystemTime(NOW + 23 * 60 * 60 * 1000);
    expect(getCachedQuote(quote.quoteId, KEY)).toMatchObject({
      depositTxHash: "0xaa",
      handedOver: "relayed_for_refund",
    });

    const dropped = quoteDue(15);
    claimDeposit(dropped.quoteId, "0xbb");
    clearQuoteCache();
    markRelayedForRefund(dropped);
    expect(getCachedQuote(dropped.quoteId, KEY)).toMatchObject({ handedOver: "relayed_for_refund" });
    // Put back into an empty cache, it's still swept once its day is over.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 60_000);
    expect(getCachedQuote(dropped.quoteId, KEY)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a cancel the hub confirmed while the submit ran: submitted doesn't overwrite it", () => {
    const quote = quoteDue(15);
    claimDeposit(quote.quoteId, "0x01");
    markHubOutcome(quote, "cancelled");
    markSubmitted(quote.quoteId);
    expect(getCachedQuote(quote.quoteId, KEY)).toMatchObject({ handedOver: "cancelled" });
  });

  it("returns nothing for an unknown id", () => {
    expect(getCachedQuote("not-a-quote", KEY)).toBeUndefined();
  });

  it("when full, drops an expired quote, an unclaimed one past its deadline, then a hub swap the hub holds, never a live or other claimed one", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const live = quoteDue(15);
    const expired = quoteDue(-31);
    const pastDeadline = quoteDue(-1);
    const claimed = quoteDue(-2);
    claimDeposit(claimed.quoteId, "0x01");
    const relayed = quoteDue(-3);
    claimDeposit(relayed.quoteId, "0x02");
    markRelayedForRefund(relayed);
    const leftToRefund = quoteDue(-4);
    claimDeposit(leftToRefund.quoteId, "0x03");
    markHubOutcome(leftToRefund, "left_to_refund");
    const cancelled = quoteDue(-5);
    claimDeposit(cancelled.quoteId, "0x04");
    markHubOutcome(cancelled, "cancelled");
    for (let i = 0; i < 9_993; i++) quoteDue(15, `key-${i % 20}`);

    // Full, within a minute of the last sweep: the expired quote goes first.
    const next = quoteDue(15);
    expect(getCachedQuote(expired.quoteId, KEY)).toBeUndefined();
    expect(getCachedQuote(pastDeadline.quoteId, KEY)).toBeDefined();

    quoteDue(15);
    expect(getCachedQuote(pastDeadline.quoteId, KEY)).toBeUndefined();
    expect(getCachedQuote(leftToRefund.quoteId, KEY)).toBeDefined();

    // Then a swap that ended, though newer; then one waiting for its refund, which only loses its early cancel here.
    // A relayed deposit's quote is its only record, so it stays.
    quoteDue(15);
    expect(getCachedQuote(cancelled.quoteId, KEY)).toBeUndefined();
    expect(getCachedQuote(leftToRefund.quoteId, KEY)).toBeDefined();
    quoteDue(15);
    expect(getCachedQuote(leftToRefund.quoteId, KEY)).toBeUndefined();

    // Nothing left that can go: new quotes wait, before any is built.
    expect(refusal(() => quoteDue(15))).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSec: 60 } });
    expect(() => checkQuoteRoom("c".repeat(64))).toThrow("too many open swap quotes");
    for (const kept of [live, claimed, relayed, next]) expect(getCachedQuote(kept.quoteId, KEY)).toBeDefined();
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
  });

  it("makes a key with 1,000 open quotes wait until one passes its sign-by untracked, never dropping another's", () => {
    const other = quoteDue(15, "b".repeat(64));
    const [tracked, untracked] = Array.from({ length: 1_000 }, () => quoteDue(15));
    const refused = refusal(() => quoteDue(15));
    // Every quote is still to be sent: the first gives way 5 minutes after it was made.
    expect(refused).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSec: 5 * 60 } });
    expect(() => checkQuoteRoom(KEY)).toThrow(refused as Error);
    vi.setSystemTime(NOW + 4 * 60_000);
    holdForTrack(tracked);

    vi.setSystemTime(NOW + 5 * 60_000);
    expect(quoteDue(15).quoteId).toEqual(expect.any(String));
    // The oldest nobody holds went; the held one, and another key's, stay.
    expect(getCachedQuote(untracked.quoteId, KEY)).toBeUndefined();
    expect(getCachedQuote(tracked.quoteId, KEY)).toMatchObject({ quoteId: tracked.quoteId });
    expect(getCachedQuote(other.quoteId, "b".repeat(64))).toMatchObject({ quoteId: other.quoteId });
    // A track call holds it 5 minutes, not for good.
    vi.setSystemTime(NOW + 9 * 60_000);
    quoteDue(15);
    expect(getCachedQuote(tracked.quoteId, KEY)).toBeUndefined();
  });

  it("keeps a quote a track call holds when the cache is full, past its deadline too, until the hold ends", () => {
    const held = quoteDue(15);
    const unheld = quoteDue(15);
    for (let i = 0; i < 9_998; i++) quoteDue(60, `key-${i % 20}`);
    vi.setSystemTime(NOW + 14 * 60_000);
    holdForTrack(held);

    // Its deposit may land after the deadline and need relaying for refund, with the quote.
    vi.setSystemTime(NOW + 16 * 60_000);
    quoteDue(60);
    expect(getCachedQuote(unheld.quoteId, KEY)).toBeUndefined();
    expect(getCachedQuote(held.quoteId, KEY)).toMatchObject({ quoteId: held.quoteId });

    vi.setSystemTime(NOW + 19 * 60_000);
    quoteDue(60);
    expect(getCachedQuote(held.quoteId, KEY)).toBeUndefined();
  });

  it("counts as open, for /health, every quote not handed over and not expired, until the last one expires", () => {
    expect(openQuotes()).toEqual({ open: 0, openUntil: null });
    quoteDue(15);
    const late = quoteDue(20);
    claimDeposit(quoteDue(10).quoteId, "0x01"); // claimed, not yet submitted: a restart still loses it
    const submitted = quoteDue(25);
    markSubmitted(submitted.quoteId);
    markRelayedForRefund(quoteDue(25));
    expect(openQuotes()).toEqual({ open: 3, openUntil: new Date(late.expiresAt).toISOString() });
    vi.setSystemTime(late.expiresAt);
    expect(openQuotes()).toEqual({ open: 0, openUntil: null });
  });

  it("refuses a client at its cap of open quotes whatever keys it sends, and no other client", () => {
    const keyed = (i: number) => `${i}`.padStart(64, "d");
    const [first] = runWithRequestContext({ clientId: "busy" }, () =>
      Array.from({ length: 100 }, (_, i) => quoteDue(15, keyed(i))),
    );
    const refused = refusal(() => runWithRequestContext({ clientId: "busy" }, () => quoteDue(15, keyed(500))));
    expect(refused).toMatchObject({ code: "RATE_LIMITED", message: "This client has too many open swap quotes." });
    expect(() => runWithRequestContext({ clientId: "other" }, () => quoteDue(15, keyed(500)))).not.toThrow();
    // A claimed quote frees its client's room as it frees its key's.
    claimDeposit(first.quoteId, "0x01");
    expect(() => runWithRequestContext({ clientId: "busy" }, () => quoteDue(15, keyed(501)))).not.toThrow();
  });

  it("doesn't count a quote a deposit claimed toward its key's cap", () => {
    const [first] = Array.from({ length: 1_000 }, () => quoteDue(15));
    expect(() => checkQuoteRoom(KEY)).toThrow("too many open swap quotes");
    claimDeposit(first.quoteId, "0x01");
    expect(() => quoteDue(15)).not.toThrow();
  });
});
