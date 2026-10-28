/**
 * A per-module response cache: an entry expires `ttlMs` after it was stored.
 * The data API and solver clients each keep one, so `sodax_refresh_cache` can
 * report what it cleared per cache.
 */

import { CACHE_DURATION_MS } from "../constants.js";

export class TtlCache {
  private readonly entries = new Map<string, { data: unknown; storedAt: number }>();

  constructor(private readonly ttlMs = CACHE_DURATION_MS) {}

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
    this.entries.set(key, { data, storedAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): { size: number; keys: string[] } {
    return { size: this.entries.size, keys: Array.from(this.entries.keys()) };
  }
}
