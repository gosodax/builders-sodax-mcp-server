import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import { getEvmReceipt, isTxKnown } from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { REDIS_URLS, openRedisStore } from "../services/swap/__fixtures__/redis.js";
import { clearAlerts } from "../services/swap/alerts.js";
import { MemoryQuoteStore } from "../services/swap/memoryQuoteStore.js";
import { useQuoteStore } from "../services/swap/quoteCache.js";
import type { QuoteStore } from "../services/swap/quoteStore.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { clearUnseenMemo, trackWait } from "../services/swap/track.js";
import { DEADLINE, DEPOSIT_RECEIPT, NOW, TX, cacheQuote, callTool, stubBackend } from "./__fixtures__/swapBackend.js";

// Unit tests don't reach a chain: receipts are scripted per test.
vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return { ...actual, getEvmReceipt: vi.fn(), hubIntentClosed: vi.fn(), isTxKnown: vi.fn() };
});

const track = (args: Record<string, unknown>) => callTool("sodax_swap_submit_and_track", args);
const cancel = (args: Record<string, unknown>) => callTool("sodax_swap_cancel", args);
const paths = (calls: { path: string }[], path: string) => calls.filter(call => call.path === path);
const realSleep = trackWait.sleep;

// With a Redis to test against only (__fixtures__/redis.ts).
const [url = ""] = REDIS_URLS;

describe.runIf(url)("swap tools on a Redis quote store, across a restart", () => {
  const prefix = `test:${randomUUID()}:`;
  const opened: QuoteStore[] = [];

  /** This server started again: a new client on the same Redis, as a deploy brings up. */
  async function restart() {
    await opened.at(-1)?.close();
    const store = await openRedisStore(url, prefix);
    opened.push(store);
    useQuoteStore(store);
  }

  beforeEach(async () => {
    Object.assign(trackWait, { stepMs: 1, maxMs: 0 });
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    clearSwapCatalogCache();
    clearCache();
    clearAlerts();
    clearUnseenMemo();
    vi.mocked(getEvmReceipt).mockResolvedValue(DEPOSIT_RECEIPT);
    vi.mocked(isTxKnown).mockResolvedValue(true);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await restart();
  });

  afterEach(() => {
    Object.assign(trackWait, { stepMs: 5_000, maxMs: 20_000, sleep: realSleep });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(getEvmReceipt).mockReset();
    vi.mocked(isTxKnown).mockReset();
  });

  afterAll(async () => {
    await opened.at(-1)?.clear();
    await Promise.all(opened.map(store => store.close()));
    useQuoteStore(new MemoryQuoteStore());
  });

  it("submits a deposit sent before the restart, once", async () => {
    const calls = stubBackend();
    const { quoteId } = await cacheQuote();
    await restart();
    expect((await track({ txHash: TX, quoteId })).out).toMatchObject({ status: "queued", quoteId });
    await restart();
    expect((await track({ txHash: TX, quoteId })).out).toMatchObject({ status: "queued" });
    expect(paths(calls, "/submit-tx")).toHaveLength(1);
  });

  it("relays an expired deposit for refund after a restart, and remembers it relayed after another", async () => {
    const calls = stubBackend();
    const { quoteId } = await cacheQuote();
    await restart();
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    expect((await track({ txHash: TX, quoteId })).out).toMatchObject({ status: "expired_refunding" });
    await restart();
    expect((await track({ txHash: TX, quoteId })).out).toMatchObject({ status: "expired_refunding" });
    expect((await cancel({ txHash: TX, quoteId })).out).toMatchObject({
      status: "not_cancellable",
      reason: "refunding",
    });
    expect(paths(calls, "/intents/submit")).toHaveLength(1);
    expect(paths(calls, "/submit-tx")).toEqual([]);
  });

  it("refunds through cancel a deposit never tracked, after a restart", async () => {
    const calls = stubBackend({ row: null });
    const { quoteId } = await cacheQuote();
    await restart();
    expect((await cancel({ txHash: TX, quoteId })).out).toMatchObject({ status: "deposit_unsubmitted" });
    vi.setSystemTime(Number(DEADLINE) * 1000 + 60_000);
    await restart();
    expect((await cancel({ txHash: TX, quoteId })).out).toMatchObject({
      status: "not_cancellable",
      reason: "refunding",
    });
    expect(paths(calls, "/intents/submit")).toHaveLength(1);
  });
});
