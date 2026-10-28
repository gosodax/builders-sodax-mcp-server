import { afterEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "./ttlCache.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TtlCache", () => {
  it("returns an entry until its TTL passes, then forgets it", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const cache = new TtlCache(1000);
    cache.set("k", [1]);
    now.mockReturnValue(1000);
    expect(cache.get("k")).toEqual([1]);
    now.mockReturnValue(1001);
    expect(cache.get("k")).toBeNull();
    expect(cache.stats().size).toBe(0);
  });

  it("reports and clears its entries", () => {
    const cache = new TtlCache();
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.stats()).toEqual({ size: 2, keys: ["a", "b"] });
    cache.clear();
    expect(cache.stats()).toEqual({ size: 0, keys: [] });
  });
});
