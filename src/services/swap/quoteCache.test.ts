import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkQuoteRoom,
  claimDeposit,
  clearQuoteCache,
  getCachedQuote,
  markRelayedForRefund,
  markSubmitted,
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
});

describe("quoteCache", () => {
  it("keeps a quote until 30 minutes past its deadline", () => {
    const { quoteId } = quoteDue(15);
    vi.setSystemTime(NOW + 44 * 60_000);
    expect(getCachedQuote(quoteId, KEY)?.quoteId).toBe(quoteId);
    vi.setSystemTime(NOW + 45 * 60_000);
    expect(getCachedQuote(quoteId, KEY)).toBeUndefined();
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
  });

  it("returns nothing for an unknown id", () => {
    expect(getCachedQuote("not-a-quote", KEY)).toBeUndefined();
  });

  it("when full, drops an expired quote, then an unclaimed one past its deadline, never a live or claimed one", () => {
    const live = quoteDue(15);
    const expired = quoteDue(-31);
    const pastDeadline = quoteDue(-1);
    const claimed = quoteDue(-2);
    claimDeposit(claimed.quoteId, "0x01");
    const relayed = quoteDue(-3);
    claimDeposit(relayed.quoteId, "0x02");
    markRelayedForRefund(relayed);
    for (let i = 0; i < 9_995; i++) quoteDue(15, `key-${i % 20}`);

    // Full, within a minute of the last sweep: the expired quote goes first.
    const next = quoteDue(15);
    expect(getCachedQuote(expired.quoteId, KEY)).toBeUndefined();
    expect(getCachedQuote(pastDeadline.quoteId, KEY)).toBeDefined();

    quoteDue(15);
    expect(getCachedQuote(pastDeadline.quoteId, KEY)).toBeUndefined();

    // Nothing left that can go: new quotes wait, before any is built.
    expect(refusal(() => quoteDue(15))).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSec: 60 } });
    expect(() => checkQuoteRoom("c".repeat(64))).toThrow("too many open swap quotes");
    for (const kept of [live, claimed, relayed, next]) expect(getCachedQuote(kept.quoteId, KEY)).toBeDefined();
  });

  it("makes a key with 1,000 open quotes wait until one leaves the cache, never dropping another key's", () => {
    const other = quoteDue(15, "b".repeat(64));
    for (let i = 0; i < 1_000; i++) quoteDue(15);
    const refused = refusal(() => quoteDue(15));
    // A quote stays in the cache 30 minutes past its deadline, so it counts until then.
    expect(refused).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSec: 45 * 60 } });
    expect(() => checkQuoteRoom(KEY)).toThrow(refused as Error);
    expect(getCachedQuote(other.quoteId, "b".repeat(64))).toMatchObject({ quoteId: other.quoteId });

    vi.setSystemTime(NOW + 15 * 60_000);
    expect(() => checkQuoteRoom(KEY)).toThrow("too many open swap quotes");
    vi.setSystemTime(NOW + 45 * 60_000);
    expect(quoteDue(15).quoteId).toEqual(expect.any(String));
  });

  it("doesn't count a quote a deposit claimed toward its key's cap", () => {
    const [first] = Array.from({ length: 1_000 }, () => quoteDue(15));
    expect(() => checkQuoteRoom(KEY)).toThrow("too many open swap quotes");
    claimDeposit(first.quoteId, "0x01");
    expect(() => quoteDue(15)).not.toThrow();
  });
});
