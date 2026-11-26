/**
 * Quotes in this process's memory: the default, for stdio, local runs and tests. A restart loses them (README,
 * Operating the swap tools). Copies in and out, as Redis does, so callers see the same behaviour from both.
 */

import {
  type CachedQuote,
  type HandedOver,
  MAX_QUOTES,
  MAX_QUOTES_PER_KEY,
  type OpenQuotes,
  type QuoteStore,
  type RelayClaim,
  type Room,
  type UnusedQuote,
  deadlineMs,
  outranked,
} from "./quoteStore.js";

const unused = (quote: CachedQuote, reason: UnusedQuote["reason"]): UnusedQuote => ({
  quoteId: quote.quoteId,
  srcChainKey: quote.srcChainKey,
  dstChainKey: quote.dstChainKey,
  keyHash: quote.keyHash,
  reason,
});

/** The order quotes give way in past their deadline (`QuoteStore.reserve`); `undefined` never does. */
function evictionRank({ depositTxHash, handedOver }: CachedQuote): 0 | 1 | 2 | undefined {
  if (depositTxHash === undefined) return 0;
  if (handedOver === "submitted" || handedOver === "cancelled" || handedOver === "closed") return 1;
  return handedOver === "left_to_refund" ? 2 : undefined;
}

export class MemoryQuoteStore implements QuoteStore {
  readonly kind = "memory";
  // Insertion order is age order, which eviction relies on.
  private readonly quotes = new Map<string, CachedQuote>();
  // Per key, its unclaimed quotes' expiry in epoch ms, by quoteId.
  private readonly openByKey = new Map<string, Map<string, number>>();
  // Until when a call's relay for refund runs, in epoch ms, by quoteId.
  private readonly relaying = new Map<string, number>();

  async reserve(keyHash: string, now: number, quote?: CachedQuote): Promise<Room> {
    const open = this.openByKey.get(keyHash);
    if (open && open.size >= MAX_QUOTES_PER_KEY) {
      for (const [quoteId, expiresAt] of open) if (expiresAt <= now) open.delete(quoteId);
      if (open.size >= MAX_QUOTES_PER_KEY) return { full: "key", retryAt: Math.min(...open.values()), unused: [] };
    }
    const dropped: UnusedQuote[] = [];
    if (this.quotes.size >= MAX_QUOTES && !this.makeRoom(now, dropped)) return { full: "store", unused: dropped };
    if (quote) {
      this.quotes.set(quote.quoteId, structuredClone(quote));
      const keyOpen = this.openByKey.get(keyHash) ?? new Map<string, number>();
      keyOpen.set(quote.quoteId, quote.expiresAt);
      this.openByKey.set(keyHash, keyOpen);
    }
    return { unused: dropped };
  }

  /** Drops expired quotes, then if still full the oldest one past its deadline, in `evictionRank` order. */
  private makeRoom(now: number, dropped: UnusedQuote[]): boolean {
    dropped.push(...this.sweepNow(now));
    if (this.quotes.size < MAX_QUOTES) return true;
    for (const rank of [0, 1, 2]) {
      for (const cached of this.quotes.values()) {
        if (deadlineMs(cached) > now || evictionRank(cached) !== rank) continue;
        this.drop(cached);
        if (rank === 0) dropped.push(unused(cached, "evicted"));
        return true;
      }
    }
    return false;
  }

  private sweepNow(now: number): UnusedQuote[] {
    const dropped: UnusedQuote[] = [];
    for (const cached of this.quotes.values()) {
      if (cached.expiresAt > now) continue;
      this.drop(cached);
      if (cached.depositTxHash === undefined) dropped.push(unused(cached, "expired"));
    }
    return dropped;
  }

  private drop(quote: CachedQuote): void {
    this.quotes.delete(quote.quoteId);
    this.relaying.delete(quote.quoteId);
    this.release(quote);
  }

  /** No longer counts toward its key's cap: claimed, or gone. */
  private release(quote: CachedQuote): void {
    const open = this.openByKey.get(quote.keyHash);
    open?.delete(quote.quoteId);
    if (open?.size === 0) this.openByKey.delete(quote.keyHash);
  }

  async get(quoteId: string): Promise<CachedQuote | undefined> {
    const quote = this.quotes.get(quoteId);
    return quote && structuredClone(quote);
  }

  async discard(quoteId: string): Promise<void> {
    const quote = this.quotes.get(quoteId);
    if (quote) this.drop(quote);
  }

  async claim(quoteId: string, txHash: string): Promise<"claimed" | "taken" | "gone"> {
    const quote = this.quotes.get(quoteId);
    if (!quote) return "gone";
    if (quote.depositTxHash === undefined) {
      quote.depositTxHash = txHash;
      this.release(quote);
    }
    return quote.depositTxHash === txHash ? "claimed" : "taken";
  }

  async set(quoteId: string, fields: Pick<CachedQuote, "submitRetryAt" | "submitRefused">): Promise<void> {
    const quote = this.quotes.get(quoteId);
    if (quote) Object.assign(quote, fields);
  }

  async setSubmitted(quoteId: string): Promise<void> {
    const quote = this.quotes.get(quoteId);
    if (quote && !quote.handedOver) quote.handedOver = "submitted";
  }

  async handOver(quote: CachedQuote & { handedOver: HandedOver }): Promise<void> {
    const stored = this.quotes.get(quote.quoteId);
    if (!stored) {
      this.quotes.set(quote.quoteId, structuredClone(quote));
      return;
    }
    if (outranked(quote.handedOver, stored.handedOver)) return;
    stored.handedOver = quote.handedOver;
    stored.expiresAt = Math.max(stored.expiresAt, quote.expiresAt);
  }

  async claimRelay(quoteId: string, now: number, until: number): Promise<RelayClaim> {
    const quote = this.quotes.get(quoteId);
    if (!quote) return "go";
    if (quote.handedOver) return quote.handedOver;
    const busyUntil = this.relaying.get(quoteId) ?? 0;
    if (busyUntil > now) return { busyUntil };
    this.relaying.set(quoteId, until);
    return "go";
  }

  async releaseRelay(quoteId: string, until: number): Promise<void> {
    if (this.relaying.get(quoteId) === until) this.relaying.delete(quoteId);
  }

  async trackedSince(quoteId: string, txHash: string, now: number): Promise<number | undefined> {
    const quote = this.quotes.get(quoteId);
    if (!quote) return undefined;
    if (quote.trackedSince?.txHash !== txHash) quote.trackedSince = { txHash, at: now };
    return quote.trackedSince.at;
  }

  async open(now: number): Promise<OpenQuotes> {
    return this.openNow(now);
  }

  openNow(now: number): OpenQuotes {
    let open = 0;
    let until = 0;
    for (const quote of this.quotes.values()) {
      if (quote.handedOver || quote.expiresAt <= now) continue;
      open++;
      until = Math.max(until, quote.expiresAt);
    }
    return { open, until };
  }

  async sweep(now: number): Promise<UnusedQuote[]> {
    return this.sweepNow(now);
  }

  async clear(): Promise<void> {
    this.quotes.clear();
    this.openByKey.clear();
    this.relaying.clear();
  }

  async close(): Promise<void> {}
}
