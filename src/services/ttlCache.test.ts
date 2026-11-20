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

  it("when full, drops what expired, then the oldest live entries", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const cache = new TtlCache(1000, 2);
    cache.set("a", 1);
    now.mockReturnValue(500);
    cache.set("b", 2);
    cache.set("a", 3); // stored again: now the newest
    cache.set("c", 4);
    expect(cache.stats().keys).toEqual(["a", "c"]);
    now.mockReturnValue(1600);
    cache.set("d", 5);
    expect(cache.stats().keys).toEqual(["d"]);
  });

  it("reports, deletes and clears its entries", () => {
    const cache = new TtlCache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.delete("c");
    expect(cache.stats()).toEqual({ size: 2, keys: ["a", "b"] });
    cache.clear();
    expect(cache.stats()).toEqual({ size: 0, keys: [] });
  });
});
