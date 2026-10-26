import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQuoteCache, getCachedQuote, putQuote } from "./quoteCache.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");

/** A quote whose deadline is `minutes` from now. */
function quoteDue(minutes: number) {
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
  });
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
    expect(getCachedQuote(quoteId)?.quoteId).toBe(quoteId);
    vi.setSystemTime(NOW + 45 * 60_000);
    expect(getCachedQuote(quoteId)).toBeUndefined();
  });

  it("returns nothing for an unknown id", () => {
    expect(getCachedQuote("not-a-quote")).toBeUndefined();
  });

  it("when full, drops an expired quote before any live one, then the oldest", () => {
    const oldest = quoteDue(15);
    const expired = quoteDue(-31);
    for (let i = 0; i < 9_998; i++) quoteDue(15);

    // Full, within a minute of the last sweep: the expired quote goes, not the oldest live one.
    const next = quoteDue(15);
    expect(getCachedQuote(expired.quoteId)).toBeUndefined();
    expect(getCachedQuote(oldest.quoteId)).toBeDefined();
    expect(getCachedQuote(next.quoteId)).toBeDefined();

    quoteDue(15);
    expect(getCachedQuote(oldest.quoteId)).toBeUndefined();
  });
});
