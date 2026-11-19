import { describe, expect, it } from "vitest";
import { refreshCaches } from "./sodaxApi.js";

describe("refreshCaches", () => {
  it("clears at most once a minute, server-wide", () => {
    const start = 1_000_000;
    expect(refreshCaches(start)).toMatch(/^Cache cleared\./);
    expect(refreshCaches(start + 30_000)).toBe(
      "Not cleared: the caches were cleared 30 s ago, and clearing again is allowed in 30 s.",
    );
    expect(refreshCaches(start + 59_999)).toMatch(/allowed in 1 s\.$/);
    expect(refreshCaches(start + 60_000)).toMatch(/^Cache cleared\./);
  });

  it("isn't held shut by a clock stepped back", () => {
    const start = 10_000_000;
    expect(refreshCaches(start)).toMatch(/^Cache cleared\./);
    expect(refreshCaches(start - 3_600_000)).toMatch(/^Cache cleared\./);
  });
});
