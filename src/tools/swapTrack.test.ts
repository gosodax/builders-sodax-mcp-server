import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import { setFallbackRequestContext } from "../services/requestContext.js";
import { getEvmReceipt, isTxKnown } from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { clearAlerts } from "../services/swap/alerts.js";
import { claimDeposit, clearQuoteCache } from "../services/swap/quoteCache.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import {
  ARBITRUM,
  CREATOR,
  DEADLINE,
  DEPOSIT_RECEIPT,
  INTENT,
  NOW,
  TX,
  USER,
  cacheQuote,
  callTool,
  stubBackend,
} from "./__fixtures__/swapBackend.js";

// Unit tests don't reach a chain: receipts are scripted per test.
vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return { ...actual, getEvmReceipt: vi.fn(), isTxKnown: vi.fn() };
});

const HUB_TX = `0x${"b".repeat(64)}`;
const OTHER_TX = `0x${"e".repeat(64)}`;
const track = (args: Record<string, unknown>) => callTool("sodax_swap_track", args);
const submits = (calls: { path: string }[]) => calls.filter(call => call.path === "/submit-tx");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearSwapCatalogCache();
  clearCache();
  clearQuoteCache();
  clearAlerts();
  vi.mocked(getEvmReceipt).mockResolvedValue(DEPOSIT_RECEIPT);
  vi.mocked(isTxKnown).mockResolvedValue(true);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(getEvmReceipt).mockReset();
  vi.mocked(isTxKnown).mockReset();
  setFallbackRequestContext({});
});

describe("sodax_swap_track", () => {
  it("checks the deposit, submits the quoted intent once, and reports it queued", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "queued", txHash: TX, quoteId, chain: { key: ARBITRUM }, retryAfterSec: 15 });
    expect(out.nextStep).toContain("call sodax_swap_track again in about 15 seconds");
    const [submit] = submits(calls);
    expect(submit.body).toEqual({
      txHash: TX,
      srcChainKey: ARBITRUM,
      walletAddress: USER,
      intent: INTENT,
      relayData: expect.stringMatching(/^0x[0-9a-f]+$/),
    });
    expect(Object.keys(submit.body?.intent ?? {})).toHaveLength(14);
  });

  it("submits once over five calls, and once for two at the same time", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    for (let i = 0; i < 5; i++) await track({ txHash: TX, quoteId });
    expect(submits(calls)).toHaveLength(1);

    clearQuoteCache();
    const again = stubBackend();
    const second = cacheQuote();
    await Promise.all([track({ txHash: TX, quoteId: second.quoteId }), track({ txHash: TX, quoteId: second.quoteId })]);
    expect(submits(again)).toHaveLength(1);
  });

  it("reports a tx it already submitted as queued while the backend has no row yet, without reading or submitting again", async () => {
    const calls = stubBackend({ row: null });
    const { quoteId } = cacheQuote();
    await track({ txHash: TX, quoteId });
    vi.mocked(getEvmReceipt).mockClear();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).toBe("queued");
    expect(submits(calls)).toHaveLength(1);
    expect(getEvmReceipt).not.toHaveBeenCalled();
  });

  it("takes a duplicate as submitted, and asks for one spelling of the hash", async () => {
    const calls = stubBackend({ submit: () => Response.json({ success: true, data: { status: "duplicate" } }) });
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX.toUpperCase().replace("0X", "0x"), quoteId });
    expect(out.status).toBe("queued");
    expect(calls[0].path).toContain(`txHash=${TX}`);
  });

  it.each([
    [true, ""],
    [false, "not a batch id"],
  ])("waits for an unmined tx (seen: %s)", async (seen, hint) => {
    const calls = stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    vi.mocked(isTxKnown).mockResolvedValue(seen);
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: seen, retryAfterSec: 15 });
    expect(out.nextStep).toContain("don't resend it");
    if (hint) expect(out.nextStep).toContain(hint);
    expect(submits(calls)).toEqual([]);
  });

  it("reports a reverted tx as failed at the source", async () => {
    stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue({ ...DEPOSIT_RECEIPT, reverted: true });
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out.status).toBe("source_failed");
    expect(out.nextStep).toContain("nothing was swapped");
  });

  it("refuses a tx that isn't a deposit (an approve), or another quote's deposit", async () => {
    const calls = stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValueOnce({ reverted: false, logs: [] });
    const approve = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(approve.out).toMatchObject({ status: "not_submitted", reason: "not_a_deposit" });

    const other = cacheQuote({ relayData: { address: USER, payload: "0x01" } });
    const mismatch = await track({ txHash: TX, quoteId: other.quoteId });
    expect(mismatch.out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch" });
    expect(submits(calls)).toEqual([]);
  });

  it("won't submit a second deposit for a used quote, and alerts", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    claimDeposit(quoteId, OTHER_TX);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "quote_used" });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ alert: "quote_used" }), expect.any(String));
    expect(submits(calls)).toEqual([]);
  });

  it("relays an expired deposit for refund once, then reports it without calling again", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    const first = await track({ txHash: TX, quoteId });
    expect(first.out.status).toBe("expired_refunding");
    expect(calls.find(call => call.path === "/intents/submit")?.body).toEqual({ chainId: "23", txHash: TX });

    vi.mocked(getEvmReceipt).mockClear();
    const second = await track({ txHash: TX, quoteId });
    expect(second.out.status).toBe("expired_refunding");
    expect(getEvmReceipt).not.toHaveBeenCalled();
    expect(calls.filter(call => call.path === "/intents/submit")).toHaveLength(1);
    expect(submits(calls)).toEqual([]);
  });

  it("alerts when an expired deposit can't be relayed, and tries again on the next call", async () => {
    const calls = stubBackend({ relay: () => Response.json({ result: { success: false, message: "" } }) });
    const { quoteId } = cacheQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "expired_unsubmitted", alerted: true });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "refund_relay_failed", deadline: DEADLINE }),
      expect.any(String),
    );
    await track({ txHash: TX, quoteId });
    expect(calls.filter(call => call.path === "/intents/submit")).toHaveLength(2);
  });

  it("hands a checked deposit the backend refuses at its deadline to the hub for refund, instead of asking for another", async () => {
    const calls = stubBackend({ submit: () => Response.json({ message: "deadline passed" }, { status: 400 }) });
    const { quoteId } = cacheQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 - 30_000);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).toBe("expired_refunding");
    expect(calls.find(call => call.path === "/intents/submit")?.body).toEqual({ chainId: "23", txHash: TX });
  });

  it("surfaces a refusal long before the deadline and alerts, then refunds once the quote has expired", async () => {
    const calls = stubBackend({
      row: null,
      submit: () => Response.json({ message: "intent must be an object" }, { status: 400 }),
    });
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.error.code).toBe("SWAP_REJECTED");
    expect(out.nextStep).toContain("the deposit is on chain and safe");
    expect(out.nextStep).toContain("must not send it again");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "submit_rejected" }),
      expect.any(String),
    );
    expect(calls.some(call => call.path === "/intents/submit")).toBe(false);

    vi.setSystemTime(Number(DEADLINE) * 1000);
    expect((await track({ txHash: TX, quoteId })).out.status).toBe("expired_refunding");
  });

  it("keeps the quote for a deposit whose submit may have reached the backend, and submits it again", async () => {
    let attempt = 0;
    const calls = stubBackend({
      row: null,
      submit: () =>
        ++attempt === 1
          ? new Response("", { status: 504 })
          : Response.json({ success: true, data: { status: "duplicate" } }),
    });
    const { quoteId } = cacheQuote();
    expect((await track({ txHash: TX, quoteId })).out.error.code).toBe("UPSTREAM_UNAVAILABLE");

    const second = await track({ txHash: OTHER_TX, quoteId });
    expect(second.out).toMatchObject({ status: "not_submitted", reason: "quote_used" });
    expect((await track({ txHash: TX, quoteId })).out.status).toBe("queued");
    expect(submits(calls).map(call => call.body?.txHash)).toEqual([TX, TX]);
  });

  it("retries a relay the service is rate-limiting, without alerting", async () => {
    const calls = stubBackend({ relay: () => new Response("", { status: 429, headers: { "Retry-After": "9" } }) });
    const { quoteId } = cacheQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.error).toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 9 });
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ alert: expect.anything() }),
      expect.anything(),
    );
    await track({ txHash: TX, quoteId });
    expect(calls.filter(call => call.path === "/intents/submit")).toHaveLength(2);
  });

  it("submits only one of two deposits tracked at the same time for one quote", async () => {
    const calls = stubBackend({ row: null });
    const { quoteId } = cacheQuote();
    const results = await Promise.all([track({ txHash: TX, quoteId }), track({ txHash: OTHER_TX, quoteId })]);
    expect(submits(calls)).toHaveLength(1);
    expect(results.map(({ out }) => out.status).sort()).toEqual(["not_submitted", "queued"]);
  });

  it("waits for a pending tx whose quote is gone before deciding whether to alert", async () => {
    stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    const pending = await track({ txHash: TX, quoteId: randomUUID(), chain: "arb" });
    expect(pending.out.status).toBe("awaiting_source_confirmation");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ["whose quote is gone", { quoteId: randomUUID(), chain: "arb" }],
    ["tracked without its quoteId (after a restart)", { chain: "Arbitrum" }],
  ])("alerts on a deposit %s, and tells the agent it's safe", async (_case, args) => {
    const calls = stubBackend();
    const { out } = await track({ txHash: TX, ...args });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", alerted: true });
    expect(out.nextStep).toContain("SODAX has been alerted");
    expect(out.nextStep).toContain("must not send it again");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ alert: "unknown_quote" }), expect.any(String));
    expect(submits(calls)).toEqual([]);
  });

  it("doesn't alert on a tx without a quote that isn't a deposit", async () => {
    stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue({ reverted: false, logs: [] });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", alerted: false });
    expect(out.nextStep).toContain("ask for the swap transaction's hash");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "pending" }, { status: "queued" }],
    ...["relaying", "relayed", "posting_execution", "posted_execution"].map(stage => [
      { status: stage, result: { dstIntentTxHash: HUB_TX } },
      { status: "in_progress", stage, hubTxHash: HUB_TX },
    ]),
    [{ status: "paused" }, { status: "in_progress", stage: "unknown" }],
    [
      { status: "solved", result: { dstIntentTxHash: HUB_TX, fillTxHash: "0xfill" } },
      { status: "solved", hubTxHash: HUB_TX, fillTxHash: "0xfill" },
    ],
  ])("reports a submitted swap's status %o without checking or submitting again", async (row, expected) => {
    const calls = stubBackend({ row });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    expect(out).toMatchObject(expected);
    expect(getEvmReceipt).not.toHaveBeenCalled();
    expect(submits(calls)).toEqual([]);
  });

  it("says what the user received once solved, from the quote this server submitted it for", async () => {
    stubBackend({ row: { status: "solved", result: { dstIntentTxHash: HUB_TX } } });
    const { quoteId } = cacheQuote();
    claimDeposit(quoteId, TX);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.minimumReceived).toEqual({ amount: "4.941968", symbol: "USDC", chainName: "Sonic" });
    expect(out.nextStep).toContain("received at least 4.941968 USDC on Sonic");
  });

  it("doesn't report another swap's backend record as the quote's", async () => {
    const calls = stubBackend({ row: { status: "solved", result: { dstIntentTxHash: HUB_TX } } });
    const { quoteId } = cacheQuote({ relayData: { address: USER, payload: "0x01" } });
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch" });
    expect(out.minimumReceived).toBeUndefined();
    expect(submits(calls)).toEqual([]);
  });

  it("takes a backend record as the quote's once the tx is checked as its deposit, and holds the quote to it", async () => {
    const calls = stubBackend({ row: { status: "solved", result: { dstIntentTxHash: HUB_TX } } });
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "solved", minimumReceived: { amount: "4.941968" } });
    expect((await track({ txHash: OTHER_TX, quoteId })).out).toMatchObject({ reason: "quote_used" });
    expect(submits(calls)).toEqual([]);
  });

  it("checks one tx tracked at the same time under two quotes against each", async () => {
    const calls = stubBackend({ row: null });
    const mine = cacheQuote();
    const other = cacheQuote({ srcAddress: CREATOR });
    const [first, second] = await Promise.all([
      track({ txHash: TX, quoteId: mine.quoteId }),
      track({ txHash: TX, quoteId: other.quoteId }),
    ]);
    expect(first.out.status).toBe("queued");
    expect(second.out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch" });
    expect(submits(calls)).toHaveLength(1);
  });

  it.each([
    [{ intentCancelled: true }, "cancelled", false],
    [{ relayedForRefundAt: "2026-10-26T12:00:00Z" }, "refunding", false],
    [{ abandonedAt: "2026-10-26T12:00:00Z" }, "abandoned", true],
    [{}, "cancel_to_recover", true],
  ])("words a failure from its flags %o", async (flags, outcome, canCancel) => {
    stubBackend({
      row: {
        status: "failed",
        failedAtStep: "posting_execution",
        userMessage: "Upstream text\nwith a link",
        failureReason: "internal detail",
        result: { dstIntentTxHash: HUB_TX },
        ...flags,
      },
    });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    expect(out).toMatchObject({ status: "failed", failedAtStep: "posting_execution", outcome, canCancel });
    expect(JSON.stringify(out)).not.toMatch(/Upstream text|internal detail/);
    expect(out.nextStep.includes("sodax_swap_cancel")).toBe(canCancel);
  });

  it("can't offer a cancel before the swap reached the hub", async () => {
    stubBackend({ row: { status: "failed", failedAtStep: "made-up" } });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    expect(out).toMatchObject({ status: "failed", outcome: "unknown", canCancel: false });
    expect(out.failedAtStep).toBeUndefined();
  });

  it("refuses another key's quote before reading anything", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    setFallbackRequestContext({ apiKey: "sodax_someone_else" });
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.error.code).toBe("QUOTE_KEY_MISMATCH");
    expect(calls).toEqual([]);
    expect(getEvmReceipt).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "QUOTE_NOT_FOUND"],
    [{ quoteId: randomUUID() }, "QUOTE_NOT_FOUND"],
    [{ chain: "sonic" }, "UNSUPPORTED_SOURCE"],
    [{ chain: "sui" }, "UNSUPPORTED_SOURCE"],
    [{ chain: "atlantis" }, "UNSUPPORTED_CHAIN"],
  ])("refuses %o", async (args, code) => {
    const calls = stubBackend();
    const { out } = await track({ txHash: TX, ...args });
    expect(out.error.code).toBe(code);
    expect(submits(calls)).toEqual([]);
  });

  it("asks for the chain, keeping the quoteId, when the quote is gone", async () => {
    stubBackend();
    const { out } = await track({ txHash: TX, quoteId: randomUUID() });
    expect(out.nextStep).toBe("Call again with the same arguments plus chain set to the swap's source chain key.");
  });

  it("refuses a quoteId for another source chain", async () => {
    stubBackend();
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId, chain: "avalanche" });
    expect(out.error.code).toBe("QUOTE_MISMATCH");
  });

  it("asks for a retry, not a resend, when the chain or the backend is unavailable", async () => {
    stubBackend();
    vi.mocked(getEvmReceipt).mockRejectedValue(new Error("SDK call failed"));
    const chain = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(chain.out.error.code).toBe("CHAIN_UNAVAILABLE");
    expect(chain.out.nextStep).toBe(
      "Call sodax_swap_track again in 30 seconds with the same arguments; don't send the swap again meanwhile.",
    );

    stubBackend({ status: () => new Response("", { status: 429, headers: { "Retry-After": "7" } }) });
    const limited = await track({ txHash: TX, chain: ARBITRUM });
    expect(limited.out.error).toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 7 });
    expect(limited.out.nextStep).toContain("again in 7 seconds");
  });

  it.each([
    ["a refused submit", { submit: () => Response.json({ success: false }) }],
    ["a status of another shape", { status: () => Response.json({ success: true, data: { state: "solved" } }) }],
  ])("reports %s as the service being unavailable", async (_case, backend) => {
    stubBackend(backend);
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(out.nextStep).toContain("don't send the swap again");
  });

  it("needs a valid key to submit", async () => {
    stubBackend({ submit: () => new Response("", { status: 401 }) });
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out.error.code).toBe("API_KEY_REQUIRED");
  });

  it("refuses a hash that isn't a tx hash", async () => {
    const calls = stubBackend();
    const { isError } = await track({ txHash: "0x1234", chain: ARBITRUM });
    expect(isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
