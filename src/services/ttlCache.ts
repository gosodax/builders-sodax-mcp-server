/**
 * A per-module response cache: an entry expires `ttlMs` after it was stored.
 * The data API and solver clients each keep one, so `sodax_refresh_cache` can
 * report what it cleared per cache.
 */

import { CACHE_DURATION_MS } from "../constants.js";

export class TtlCache {
  // Insertion order is age order (`set` moves a key to the end), which eviction relies on.
  private readonly entries = new Map<string, { data: unknown; storedAt: number }>();

  /** `maxEntries` bounds a cache keyed by what callers pass. */
  constructor(
    private readonly ttlMs = CACHE_DURATION_MS,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  get<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set(key: string, data: unknown): void {
    const now = Date.now();
    this.entries.delete(key);
    // Full: oldest first, what expired goes, then live entries until there's room.
    if (this.entries.size >= this.maxEntries) {
      for (const [stored, entry] of this.entries) {
        if (now - entry.storedAt <= this.ttlMs && this.entries.size < this.maxEntries) break;
        this.entries.delete(stored);
      }
    }
    this.entries.set(key, { data, storedAt: now });
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): { size: number; keys: string[] } {
    return { size: this.entries.size, keys: Array.from(this.entries.keys()) };
  }
}
