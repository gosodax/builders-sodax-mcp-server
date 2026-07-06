import { describe, expect, it } from "vitest";
import { quoteErrorHint } from "./solverRelay.js";

describe("quoteErrorHint", () => {
  it("steers a not-compatible token toward canonical bridged *_ASSET hub tokens", () => {
    // Real upstream shape: `{ detail: { message: "One of the following tokens
    // is not compatible with the quote service: 0x…, 0x…" } }`, surfaced by the
    // http/service layers as part of the thrown Error message.
    const message =
      "Failed to fetch solver quote: HTTP 400 for https://api.sodax.com/v1/intent/quote - " +
      "One of the following tokens is not compatible with the quote service: 0xabc, 0xdef";

    const hint = quoteErrorHint(message);

    expect(hint).not.toBeNull();
    expect(hint).toContain("chainId 146");
    expect(hint).toContain("sodax_get_solver_oracle");
    // Must recommend canonical bridged *_ASSET tokens, not just "any chainId 146"
    // (per issue #64: ~half of chainId-146 oracle entries are non-quotable).
    expect(hint).toContain("*_ASSET");
    expect(hint).toContain("Not every chainId-146 oracle entry is quotable");
  });

  it("hints that 'no path' is liquidity/amount-dependent and recoverable", () => {
    const message =
      "Failed to fetch solver quote: HTTP 400 for https://api.sodax.com/v1/intent/quote - " +
      "No path was found between 0xeb0393893b5bf98a50073d6740738b08e575058b and 0xaeafa26e43f46cd83efe89b1e57c858eb5685a24";

    const hint = quoteErrorHint(message);

    expect(hint).not.toBeNull();
    expect(hint).toContain("smaller amount");
    expect(hint).toContain("liquid");
  });

  it("is case-insensitive (matches regardless of upstream casing)", () => {
    expect(quoteErrorHint("NOT COMPATIBLE WITH THE QUOTE SERVICE")).not.toBeNull();
    expect(quoteErrorHint("NO PATH WAS FOUND between a and b")).not.toBeNull();
  });

  it("returns null for unrelated errors so no misleading hint is appended", () => {
    expect(quoteErrorHint("Failed to fetch solver quote: HTTP 503 for … - upstream unavailable")).toBeNull();
    expect(quoteErrorHint("The operation was aborted due to timeout")).toBeNull();
    expect(quoteErrorHint("Unknown error")).toBeNull();
  });
});
