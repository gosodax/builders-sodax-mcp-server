import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import { setFallbackRequestContext } from "../services/requestContext.js";
import { getEvmReceipt, intentHash, isTxKnown } from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { fixtureText } from "../services/swap/__fixtures__/catalog.js";
import { messageReceipt } from "../services/swap/__fixtures__/deposit.js";
import { clearAlerts } from "../services/swap/alerts.js";
import { claimDeposit, clearQuoteCache } from "../services/swap/quoteCache.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { clearUnseenMemo, trackWait } from "../services/swap/track.js";
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
import { swapClient } from "./__fixtures__/swapClient.js";

// Unit tests don't reach a chain: receipts are scripted per test.
vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return { ...actual, getEvmReceipt: vi.fn(), hubIntentClosed: vi.fn(), isTxKnown: vi.fn() };
});

const HUB_TX = `0x${"b".repeat(64)}`;
const OTHER_TX = `0x${"e".repeat(64)}`;
const track = (args: Record<string, unknown>) => callTool("sodax_swap_submit_and_track", args);
const submits = (calls: { path: string }[]) => calls.filter(call => call.path === "/submit-tx");
const realSleep = trackWait.sleep;

beforeEach(() => {
  // A call returns at once here; the waiting has its own tests.
  Object.assign(trackWait, { stepMs: 1, maxMs: 0 });
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearSwapCatalogCache();
  clearCache();
  clearQuoteCache();
  clearAlerts();
  clearUnseenMemo();
  vi.mocked(getEvmReceipt).mockResolvedValue(DEPOSIT_RECEIPT);
  vi.mocked(isTxKnown).mockResolvedValue(true);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(trackWait, { stepMs: 5_000, maxMs: 20_000, sleep: realSleep });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(getEvmReceipt).mockReset();
  vi.mocked(isTxKnown).mockReset();
  setFallbackRequestContext({});
});

const NEVER = " The user must not send the swap again.";

describe("sodax_swap_submit_and_track", () => {
  it("checks the deposit, submits the quoted intent once, and reports it queued", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({
      status: "queued",
      txHash: TX,
      quoteId,
      intentHash: intentHash(INTENT),
      chain: { key: ARBITRUM },
      retryAfterSec: 15,
    });
    expect(out.nextStep).toContain(
      "call sodax_swap_submit_and_track again in about 15 seconds (each call also waits up to 20 seconds for the next step)",
    );
    expect(out.nextStep).toContain("at most 30 times at this step. If it's still at this step after that, stop:");
    expect(out).toMatchObject({
      terminal: false,
      nextAction: {
        type: "call_tool",
        tool: "sodax_swap_submit_and_track",
        args: { txHash: TX, chain: ARBITRUM, quoteId },
        maxAttempts: 30,
        retryKey: `sodax_swap_submit_and_track:${TX}:queued`,
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      { "chain.key": ARBITRUM, "quote.id": quoteId, "tx.hash": TX, "intent.hash": intentHash(INTENT) },
      "Submitted a swap deposit",
    );
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

  it("submits a deposit already sent though the live config's chain id now differs from the SDK's", async () => {
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    configs[ARBITRUM].chain.chainId = 8453;
    const calls = stubBackend({ configs: JSON.stringify(configs) });
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out.status).toBe("queued");
    expect(getEvmReceipt).toHaveBeenCalledWith(ARBITRUM, TX);
    expect(submits(calls)).toHaveLength(1);
  });

  it.each([{}, { chain: "arb" }, { chain: "42161" }])(
    "submits a quoted deposit from a chain the live config no longer lists (%o)",
    async args => {
      const configs = JSON.parse(fixtureText("chain-configs.json"));
      delete configs[ARBITRUM];
      const calls = stubBackend({ configs: JSON.stringify(configs) });
      const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId, ...args });
      expect(out.status).toBe("queued");
      expect(submits(calls)).toHaveLength(1);
    },
  );

  it("waits within one call until the swap moves on", async () => {
    Object.assign(trackWait, { stepMs: 1, maxMs: 60_000 });
    const rows = [{ status: "pending" }, { status: "pending" }, { status: "relaying" }, { status: "solved" }];
    const calls = stubBackend({
      status: () => Response.json({ success: true, data: { txHash: TX, srcChainKey: ARBITRUM, ...rows.shift() } }),
    });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    expect(out).toMatchObject({ status: "in_progress", stage: "relaying" });
    expect(out.nextStep).toContain("each call also waits up to 20 seconds");
    expect(calls.filter(call => call.path.startsWith("/submit-tx/status"))).toHaveLength(3);
  });

  it("stops waiting once its time is up, with the swap still waiting", async () => {
    Object.assign(trackWait, { stepMs: 1, maxMs: 5_000 });
    const calls = stubBackend({
      status: () => {
        vi.setSystemTime(Date.now() + 2_000);
        return Response.json({ success: true, data: { txHash: TX, srcChainKey: ARBITRUM, status: "pending" } });
      },
    });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    expect(out.status).toBe("queued");
    expect(calls.filter(call => call.path.startsWith("/submit-tx/status"))).toHaveLength(3);
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
    [true, "isn't confirmed on Arbitrum yet"],
    [false, "Arbitrum hasn't seen this transaction. Check that the user's wallet really broadcast it"],
  ])("waits for an unmined tx (seen: %s)", async (seen, hint) => {
    const calls = stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    vi.mocked(isTxKnown).mockResolvedValue(seen);
    const quote = cacheQuote();
    // A hash no chain can have holds nothing.
    const malformed = await track({ txHash: "0x1234", quoteId: quote.quoteId });
    expect(malformed.out.error).toMatchObject({ code: "INVALID_TX_HASH" });
    expect(quote.heldUntil).toBeUndefined();
    const { out } = await track({ txHash: TX, quoteId: quote.quoteId });
    expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: seen, retryAfterSec: 15 });
    // Named by a track call: its deposit may be on its way, so it's held from giving way to a new quote for a while.
    expect(quote.heldUntil).toBeGreaterThan(Date.now());
    expect(out.nextStep).toContain("don't resend it");
    expect(out.nextStep).toContain(hint);
    expect(out.nextStep.includes("if it was never sent, stop tracking it")).toBe(!seen);
    expect(submits(calls)).toEqual([]);
  });

  it.each([
    ["without a quote", () => ({ chain: ARBITRUM })],
    ["whose quote is gone", () => ({ quoteId: randomUUID(), chain: ARBITRUM })],
    [
      "over 5 minutes past its quote's deadline",
      () => {
        const { quoteId } = cacheQuote();
        vi.setSystemTime((Number(DEADLINE) + 5 * 60) * 1000);
        return { quoteId };
      },
    ],
  ])("stops waiting for a tx the chain hasn't seen %s", async (_case, args) => {
    stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    vi.mocked(isTxKnown).mockResolvedValue(false);
    const { out } = await track({ txHash: TX, ...args() });
    expect(out.status).toBe("source_not_found");
    expect(out).not.toHaveProperty("retryAfterSec");
    expect(out.nextStep).toContain("If the user's wallet sped it up or replaced it, call sodax_swap_submit_and_track");
    expect(out.nextStep).toContain("Only if the wallet shows it was never sent: nothing was swapped");
  });

  it("keeps waiting for an unseen tx until 5 minutes past its quote's deadline", async () => {
    stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    vi.mocked(isTxKnown).mockResolvedValue(false);
    const { quoteId } = cacheQuote();
    vi.setSystemTime((Number(DEADLINE) + 5 * 60) * 1000 - 1);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: false, retryAfterSec: 15 });
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

  it("alerts on another quote's deposit from the same sender, for an agent that has no other quoteId", async () => {
    stubBackend();
    const other = cacheQuote({ relayData: { address: USER, payload: "0x01" } });
    const { out } = await track({ txHash: TX, quoteId: other.quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch" });
    expect(out.nextStep).toContain("track it with the quoteId it was made from. Without that quoteId, tell the user");
    expect(out.nextStep).toContain("SODAX has been alerted to recover it, and they must not send it again");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "other_quote_deposit", "tx.hash": TX, "quote.id": other.quoteId }),
      expect.any(String),
    );
  });

  it("alerts on this quote's deposit sent from another address, and won't submit it", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote({ srcAddress: CREATOR });
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "other_sender" });
    expect(out.nextStep).toContain("from another address than its fromAddress");
    expect(out.nextStep).toContain("SODAX has been alerted");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "other_sender_deposit", "tx.hash": TX, "quote.id": quoteId }),
      expect.any(String),
    );
    expect(submits(calls)).toEqual([]);
  });

  it("calls someone else's deposit in the tx (a bundle's) not this quote's swap, without alerting", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote({ srcAddress: CREATOR, relayData: { address: CREATOR, payload: "0x01" } });
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "not_a_deposit" });
    expect(out.nextStep).toContain("isn't this quote's swap");
    expect(logger.error).not.toHaveBeenCalled();
    expect(submits(calls)).toEqual([]);
  });

  it("won't submit a tx with a cancel or direct message besides this swap's, as the backend follows its first packet", async () => {
    const calls = stubBackend();
    const other = messageReceipt({ srcAddress: `0x${"9".repeat(40)}`, payload: "0xc0" });
    vi.mocked(getEvmReceipt).mockResolvedValue({ ...DEPOSIT_RECEIPT, logs: [...other.logs, ...DEPOSIT_RECEIPT.logs] });
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "multiple_deposits" });
    expect(out.nextStep).toContain("another deposit or a cancel");
    expect(submits(calls)).toEqual([]);
  });

  it("won't submit a tx that holds other deposits besides this swap's, and alerts", async () => {
    const calls = stubBackend();
    const logs = [...DEPOSIT_RECEIPT.logs, ...DEPOSIT_RECEIPT.logs];
    vi.mocked(getEvmReceipt).mockResolvedValue({ ...DEPOSIT_RECEIPT, logs });
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "multiple_deposits" });
    expect(out.nextStep).toContain("send each swap as its own transaction");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "multiple_deposits", "tx.hash": TX, "quote.id": quoteId }),
      expect.any(String),
    );
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

  it("treats a quote dropped from the cache while its deposit was read as gone, not as used", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    vi.mocked(getEvmReceipt).mockImplementation(async () => {
      clearQuoteCache();
      return DEPOSIT_RECEIPT;
    });
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: true });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ alert: "unknown_quote" }), expect.any(String));
    expect(logger.error).not.toHaveBeenCalledWith(expect.objectContaining({ alert: "quote_used" }), expect.any(String));
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
    expect(out).toMatchObject({ status: "expired_unsubmitted", alerted: true, retryAfterSec: 60 });
    expect(out.nextStep).toContain(
      "To retry the refund, call sodax_swap_submit_and_track again in about 60 seconds, at most 10 times, then stop.",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "refund_relay_failed", deadline: DEADLINE }),
      expect.any(String),
    );
    await track({ txHash: TX, quoteId });
    expect(calls.filter(call => call.path === "/intents/submit")).toHaveLength(2);
  });

  it("alerts on a checked deposit refused in its last minute, and hands it to the hub for refund", async () => {
    const calls = stubBackend({
      submit: () => Response.json({ message: "intent must be an object" }, { status: 400 }),
    });
    const { quoteId } = cacheQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 - 30_000);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).toBe("expired_refunding");
    expect(calls.find(call => call.path === "/intents/submit")?.body).toEqual({ chainId: "23", txHash: TX });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "submit_rejected", deadline: DEADLINE }),
      expect.any(String),
    );
  });

  it("alerts on a refusal long before the deadline, and relays for refund on the first call after it", async () => {
    const calls = stubBackend({
      row: null,
      submit: () => Response.json({ message: "intent must be an object" }, { status: 400 }),
    });
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "submit_refused", alerted: true, retryAfterSec: 15 * 60 + 15 });
    expect(out.nextStep).toContain("the deposit is on chain and safe");
    expect(out.nextStep).toContain("must not send it again");
    expect(out.nextStep).toContain("call sodax_swap_submit_and_track again in about 915 seconds");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "submit_rejected" }),
      expect.any(String),
    );
    expect(calls.some(call => call.path === "/intents/submit")).toBe(false);

    vi.setSystemTime(NOW + 60_000);
    const repeat = await track({ txHash: TX, quoteId });
    expect(repeat.out).toMatchObject({ status: "submit_refused", retryAfterSec: 14 * 60 + 15 });
    expect(submits(calls)).toHaveLength(1);

    vi.setSystemTime(Number(DEADLINE) * 1000);
    expect((await track({ txHash: TX, quoteId })).out.status).toBe("expired_refunding");
    expect(submits(calls)).toHaveLength(1);
  });

  // The backend's clock may be ahead of ours by as much as a quote's deadline may be off it (300 s).
  it.each([
    [359, "expired_refunding"],
    [361, "submit_refused"],
  ])("relays a deposit refused %i s before its deadline for refund (%s)", async (secondsLeft, status) => {
    const calls = stubBackend({
      row: null,
      submit: () => Response.json({ message: "deadline has passed" }, { status: 400 }),
    });
    const { quoteId } = cacheQuote();
    vi.setSystemTime((Number(DEADLINE) - secondsLeft) * 1000);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).toBe(status);
    expect(calls.some(call => call.path === "/intents/submit")).toBe(status === "expired_refunding");
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
    vi.setSystemTime(Date.now() + 15_000);
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

  it("alerts on a deposit whose quote is gone, and tells the agent it's safe", async () => {
    const calls = stubBackend();
    const { out } = await track({ txHash: TX, quoteId: randomUUID(), chain: "arb" });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: true });
    expect(out.nextStep).toContain("SODAX has been alerted");
    expect(out.nextStep).toContain("must not send it again");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ alert: "unknown_quote" }), expect.any(String));
    expect(submits(calls)).toEqual([]);
  });

  it("asks for the quoteId of a deposit tracked without one, without alerting", async () => {
    const calls = stubBackend();
    const { out } = await track({ txHash: TX, chain: "Arbitrum" });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false });
    expect(out.nextStep).toBe(
      "This server has no record of that SODAX deposit. If it came from sodax_swap_prepare, call sodax_swap_submit_and_track again with the same arguments plus its quoteId; otherwise track it where it was made. Either way, the user must not send it again.",
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(submits(calls)).toEqual([]);
  });

  it.each([
    ["without a quoteId", { chain: ARBITRUM }],
    ["whose quote is gone", { quoteId: randomUUID(), chain: ARBITRUM }],
  ])("doesn't alert on a tx that isn't a deposit, %s", async (_case, args) => {
    stubBackend();
    vi.mocked(getEvmReceipt).mockResolvedValue({ reverted: false, logs: [] });
    const { out } = await track({ txHash: TX, ...args });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: false, alerted: false });
    expect(out.nextStep).toBe(
      "That transaction isn't a SODAX swap deposit on Arbitrum; ask for the swap transaction's hash.",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "pending" }, { status: "queued" }],
    ...["relaying", "relayed", "posting_execution", "posted_execution"].map(stage => [
      { status: stage, result: { dstIntentTxHash: HUB_TX } },
      { status: "in_progress", stage, hubTxHash: HUB_TX },
    ]),
    [{ status: "paused" }, { status: "unknown" }],
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

  it("polls a status it doesn't know only while the quote can still be filled", async () => {
    stubBackend({ row: { status: "paused" } });
    const { quoteId } = cacheQuote();
    claimDeposit(quoteId, TX);
    const live = await track({ txHash: TX, quoteId });
    expect(live.out).toMatchObject({ status: "in_progress", stage: "unknown", retryAfterSec: 15 });

    vi.setSystemTime(Number(DEADLINE) * 1000);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).toBe("unknown");
    expect(out).not.toHaveProperty("retryAfterSec");
    expect(out.nextStep).toContain("stop tracking it");
    expect(out.nextStep).toContain("must not send it again");
  });

  it("says what the user received once solved, from the quote this server submitted it for", async () => {
    stubBackend({ row: { status: "solved", result: { dstIntentTxHash: HUB_TX } } });
    const { quoteId } = cacheQuote();
    claimDeposit(quoteId, TX);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.minimumReceived).toEqual({ amount: "4.941968", symbol: "USDC", chainName: "Sonic" });
    expect(out.delivery).toBe("complete");
    expect(out.nextStep).toBe("The swap is complete on Sonic: the user received at least 4.941968 USDC.");
  });

  it("calls a solved swap without its quote filled on the hub, not delivered", async () => {
    stubBackend({ row: { status: "solved", result: { dstIntentTxHash: HUB_TX, fillTxHash: "0xfill" } } });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    expect(out.delivery).toBeUndefined();
    expect(out.nextStep).toBe(
      "The swap is filled on the SODAX hub (fill tx 0xfill); to a chain other than Sonic the tokens arrive after one more cross-chain hop. Don't send it again.",
    );
  });

  it("calls a solved swap to another chain filled, its tokens one cross-chain hop away", async () => {
    stubBackend({ row: { status: "solved", result: { dstIntentTxHash: HUB_TX } } });
    const minimumReceived = { amount: "4.9", symbol: "USDC", chainName: "Base" };
    const { quoteId } = cacheQuote({ dstChainKey: "0x2105.base", minimumReceived });
    claimDeposit(quoteId, TX);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.delivery).toBe("in_transit");
    expect(out.nextStep).toBe(
      "The swap is filled: at least 4.9 USDC is on its way to Base, arriving after one more cross-chain hop; sodax_get_balance on the recipient shows it arrive. Don't send it again.",
    );
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
    expect(second.out).toMatchObject({ status: "not_submitted", reason: "other_sender" });
    expect(submits(calls)).toHaveLength(1);
  });

  it.each([
    [{ intentCancelled: true }, "cancelled", false],
    [{ relayedForRefundAt: "2026-10-26T12:00:00Z" }, "refunding", false],
    [{ abandonedAt: "2026-10-26T12:00:00Z" }, "abandoned", true],
    [{}, "cancel_to_recover", true],
  ])("words a failure from its flags %o", async (flags, failure, canCancel) => {
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
    expect(out).toMatchObject({ status: "failed", failedAtStep: "posting_execution", failure, canCancel });
    expect(JSON.stringify(out)).not.toMatch(/Upstream text|internal detail/);
    expect(out.nextStep.includes("sodax_swap_cancel")).toBe(canCancel);
  });

  it("can't offer a cancel before the swap reached the hub, and says the deposit is safe", async () => {
    stubBackend({ row: { status: "failed", failedAtStep: "made-up" } });
    const { out } = await track({ txHash: TX, chain: ARBITRUM });
    // Held: the backend has its row, so the deposit is on chain, waiting for an operator.
    expect(out).toMatchObject({ status: "failed", failure: "unknown", canCancel: false, outcome: "held" });
    expect(out.failedAtStep).toBeUndefined();
    expect(out.nextStep).toBe(
      "The swap failed. The deposit is safe on chain and SODAX operators will recover it; the user must not send it again.",
    );
  });

  // The MCP SDK refuses an argument its schema rejects before the tool runs: a result outside the contract.
  it("leaves a malformed argument to the SDK, with no nextAction", async () => {
    const client = await swapClient();
    const result = await client.callTool({ name: "sodax_swap_submit_and_track", arguments: { txHash: 42 } });
    await client.close();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain("Input validation error");
  });

  it("refuses another key's quote before reading anything", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    setFallbackRequestContext({ apiKey: "sodax_someone_else" });
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.error.code).toBe("QUOTE_KEY_MISMATCH");
    // The model can't set the connection's key: the user has to know it changed.
    expect(out.nextStep).toBe(
      `This connection's SODAX API key has changed since the quote was made, and only that key can use it: tell the user.${NEVER}`,
    );
    expect(calls).toEqual([]);
    expect(getEvmReceipt).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "QUOTE_NOT_FOUND"],
    [{ quoteId: randomUUID() }, "QUOTE_NOT_FOUND"],
    [{ chain: "0x1.icon" }, "UNSUPPORTED_SOURCE"],
    [{ chain: "atlantis" }, "UNSUPPORTED_CHAIN"],
  ])("refuses %o", async (args, code) => {
    const calls = stubBackend();
    const { out } = await track({ txHash: TX, ...args });
    expect(out.error.code).toBe(code);
    expect(submits(calls)).toEqual([]);
  });

  it("asks which chain a sent swap came from, not for a new swap, when that chain can't start one", async () => {
    stubBackend();
    const { out } = await track({ txHash: TX, chain: "0x1.icon" });
    expect(out.nextStep).toMatch(
      /^No swap can start from ICON: ask the user which chain they sent the swap from \(one of .*Arbitrum.*\)/,
    );
    expect(out.error.sourceChains).toContainEqual({ key: ARBITRUM, name: "Arbitrum" });
  });

  it("suggests a misspelled source chain, listing only chains a swap can start from", async () => {
    stubBackend();
    const { out } = await track({ txHash: TX, chain: "Arbitrm" });
    expect(out.error).toMatchObject({ code: "UNSUPPORTED_CHAIN", didYouMean: [{ key: ARBITRUM }] });
    const listed = (out.error.supportedChains as { key: string }[]).map(chain => chain.key);
    expect(listed).toEqual(expect.arrayContaining(["sonic", "sui"]));
    expect(listed).not.toContain("0x1.icon");
  });

  it("asks for the chain, keeping the quoteId, when the quote is gone", async () => {
    stubBackend();
    const { out } = await track({ txHash: TX, quoteId: randomUUID() });
    expect(out.nextStep).toBe(
      `Call again with the same arguments plus chain set to the swap's source chain key.${NEVER}`,
    );
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
      "Call sodax_swap_submit_and_track again in 30 seconds with the same arguments, at most 10 times, and don't send the swap again meanwhile. If it still fails, stop: tell the user this server can't follow the swap right now, that they must not send it again, and to give the swap's transaction hash and this result's requestId to the SODAX team on Discord, https://www.sodax.com/discord.",
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

  it("treats an amount refusal after the deposit is checked as refused: alerted, deposit safe, never quote again", async () => {
    stubBackend({ submit: () => Response.json({ code: -23, message: "too low" }, { status: 400 }) });
    const { isError, out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(isError).toBeFalsy();
    expect(out).toMatchObject({ status: "submit_refused", alerted: true });
    expect(out.nextStep).toContain("must not send it again");
    expect(out.nextStep).not.toContain("larger amount");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "submit_rejected" }),
      expect.any(String),
    );
  });

  it.each([
    ["a refused key", 401],
    ["a WAF's 403", 403],
  ])("retries %s after the deposit is checked, never asking for a new key", async (_, status) => {
    const calls = stubBackend({
      submit: () => new Response("", { status }),
      // The refused submit left no row.
      status: () => Response.json({ message: "Swap transaction not found" }, { status: 404 }),
    });
    const { quoteId } = cacheQuote();
    const first = await track({ txHash: TX, quoteId });
    expect(first.out.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(first.out.nextStep).toContain("don't send the swap again");
    expect(first.out.nextStep).not.toContain("API key");
    // Not marked refused: the next call submits again.
    vi.setSystemTime(Date.now() + 15_000);
    await track({ txHash: TX, quoteId });
    expect(submits(calls)).toHaveLength(2);
  });

  it("finds the quote whatever the case of its quoteId", async () => {
    const calls = stubBackend();
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId: quoteId.toUpperCase() });
    expect(out).toMatchObject({ status: "queued", quoteId });
    expect(submits(calls)).toHaveLength(1);
  });

  it("waits out a retry sooner than told instead of spending another submit", async () => {
    const calls = stubBackend({
      submit: () => new Response("", { status: 503 }),
      status: () => Response.json({ message: "Swap transaction not found" }, { status: 404 }),
    });
    const { quoteId } = cacheQuote();
    await track({ txHash: TX, quoteId });
    vi.setSystemTime(Date.now() + 5_000);
    const early = await track({ txHash: TX, quoteId });
    expect(early.out.error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSec: 10 });
    expect(early.out.nextStep).toContain("don't send the swap again");
    expect(submits(calls)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 10_000);
    await track({ txHash: TX, quoteId });
    expect(submits(calls)).toHaveLength(2);
  });

  it("lets a retry through as soon as the swap service's own Retry-After allows", async () => {
    const calls = stubBackend({
      submit: () => new Response("", { status: 429, headers: { "Retry-After": "5" } }),
      status: () => Response.json({ message: "Swap transaction not found" }, { status: 404 }),
    });
    const { quoteId } = cacheQuote();
    expect((await track({ txHash: TX, quoteId })).out.error).toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 5 });
    vi.setSystemTime(Date.now() + 5_000);
    await track({ txHash: TX, quoteId });
    expect(submits(calls)).toHaveLength(2);
  });

  it("retries a refused status read after the deposit is checked, never asking for a new key", async () => {
    let reads = 0;
    stubBackend({
      submit: () => new Response("", { status: 503 }),
      // No row yet, then the edge refuses the key.
      status: () =>
        reads++ === 0
          ? Response.json({ message: "Swap transaction not found" }, { status: 404 })
          : new Response("", { status: 403 }),
    });
    const { quoteId } = cacheQuote();
    await track({ txHash: TX, quoteId });
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(out.nextStep).not.toContain("API key");
  });

  it("doesn't read a checked deposit again: a node that has lost its receipt can't hold up its refund", async () => {
    const calls = stubBackend({
      submit: () => new Response("", { status: 503 }),
      status: () => Response.json({ message: "Swap transaction not found" }, { status: 404 }),
    });
    const { quoteId } = cacheQuote();
    await track({ txHash: TX, quoteId });
    // A node that has dropped the tx, past the deadline: the claim is the proof, so the refund relay runs.
    vi.setSystemTime((Number(DEADLINE) + 5 * 60) * 1000);
    vi.mocked(getEvmReceipt).mockClear().mockResolvedValue(null);
    vi.mocked(isTxKnown).mockResolvedValue(false);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).toBe("expired_refunding");
    expect(getEvmReceipt).not.toHaveBeenCalled();
    expect(calls.filter(call => call.path === "/intents/submit")).toHaveLength(1);
  });

  it("says when to stop calling: once a result is terminal", async () => {
    const client = await swapClient();
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.find(tool => tool.name === "sodax_swap_submit_and_track")?.description).toContain(
      "then follow each result's nextAction until terminal is true",
    );
    for (const tool of tools) expect(tool.description).not.toContain("same API key");
  });

  it.each([
    ["a short hex value", "0x1234"],
    ["a batch id", "batch-123"],
  ])("refuses %s as a hash with a nextAction asking for one, before any read", async (_, txHash) => {
    const calls = stubBackend();
    const { out } = await track({ txHash, chain: ARBITRUM });
    expect(out.error).toMatchObject({ code: "INVALID_TX_HASH", field: "txHash" });
    expect(out.nextAction).toMatchObject({ type: "provide", fields: [{ name: "txHash" }] });
    expect(out.nextStep).toContain("not the batch id");
    expect(calls).toEqual([]);
  });

  it.each([
    ["a Solana signature", "5".repeat(88)],
    ["a bare 64-hex value", "a".repeat(64)],
  ])("refuses %s as a hash on an EVM chain, saying what one looks like there", async (_case, txHash) => {
    const calls = stubBackend();
    const { out } = await track({ txHash, chain: ARBITRUM });
    expect(out.error).toMatchObject({ code: "INVALID_TX_HASH", format: "0x and 64 hex characters" });
    expect(calls).toEqual([]);
  });
});

describe("a tx no node has seen", () => {
  beforeEach(() => {
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    vi.mocked(isTxKnown).mockResolvedValue(false);
  });

  it("is read from the chain once per 10 seconds, however often it's tracked", async () => {
    stubBackend();
    const { quoteId } = cacheQuote();
    await track({ txHash: TX, quoteId });
    await track({ txHash: TX, quoteId });
    expect(getEvmReceipt).toHaveBeenCalledTimes(1);
    expect(isTxKnown).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 11_000);
    await track({ txHash: TX, quoteId });
    expect(getEvmReceipt).toHaveBeenCalledTimes(2);
  });

  it("once seen, is read only for its receipt until it's mined", async () => {
    vi.mocked(isTxKnown).mockResolvedValue(true);
    stubBackend();
    const { quoteId } = cacheQuote();
    await track({ txHash: TX, quoteId });
    await track({ txHash: TX, quoteId });
    expect(getEvmReceipt).toHaveBeenCalledTimes(2);
    expect(isTxKnown).toHaveBeenCalledTimes(1);
  });

  it("is waited for within a call, as a tx just sent may not have reached this node, read once per 10 seconds", async () => {
    // Each wait moves the clock on at once, so the call takes no real time.
    Object.assign(trackWait, {
      stepMs: 4_000,
      maxMs: 20_000,
      sleep: async (ms: number) => vi.setSystemTime(Date.now() + ms),
    });
    const calls = stubBackend();
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out.status).toBe("awaiting_source_confirmation");
    // Tracked at 0, 4, 8, 12, 16 and 20 seconds: read at 0 and 12, once what it remembered was 10 seconds old.
    expect(calls.filter(call => call.path.startsWith("/submit-tx/status?"))).toHaveLength(2);
    expect(getEvmReceipt).toHaveBeenCalledTimes(2);
    expect(isTxKnown).toHaveBeenCalledTimes(2);
  });

  it("isn't remembered unseen for another API key", async () => {
    stubBackend();
    // Someone else tracks the hash just before the user's wallet broadcasts it.
    setFallbackRequestContext({ apiKey: "sodax_someone_else" });
    await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    setFallbackRequestContext({});
    vi.mocked(isTxKnown).mockResolvedValue(true);
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: true });
  });

  it("never calls a checked deposit unsent: it's relayed for refund past its deadline, unread", async () => {
    stubBackend();
    const { quoteId } = cacheQuote();
    claimDeposit(quoteId, TX);
    vi.setSystemTime(Number(DEADLINE) * 1000 + 10 * 60 * 1000);
    vi.mocked(getEvmReceipt).mockClear();
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).toBe("expired_refunding");
    expect(getEvmReceipt).not.toHaveBeenCalled();
  });

  it("reads the chain again before a final answer, whatever it remembered", async () => {
    stubBackend();
    const { quoteId } = cacheQuote();
    const stopAfter = Number(DEADLINE) * 1000 + 5 * 60 * 1000;
    vi.setSystemTime(stopAfter - 5_000);
    await track({ txHash: TX, quoteId });
    // Within the 10 seconds it remembers "unseen", but past the stop time: the tx was mined meanwhile.
    vi.setSystemTime(stopAfter + 1_000);
    vi.mocked(getEvmReceipt).mockResolvedValue(DEPOSIT_RECEIPT);
    const { out } = await track({ txHash: TX, quoteId });
    expect(out.status).not.toBe("source_not_found");
    expect(getEvmReceipt).toHaveBeenCalledTimes(2);
  });

  it("is polled for 15 minutes from the first call, then left to the user until it can no longer be sent", async () => {
    stubBackend();
    const { quoteId } = cacheQuote();
    const { out } = await track({ txHash: TX, quoteId });
    // About as long as 30 polls; never "not found" while the quote can still be sent, by a wallet that sends late.
    const pollUntil = new Date(NOW + 15 * 60 * 1000).toISOString();
    const stopAfter = new Date(Number(DEADLINE) * 1000 + 5 * 60 * 1000).toISOString();
    expect(out).toMatchObject({
      status: "awaiting_source_confirmation",
      seenOnChain: false,
      pollUntil,
      stopAfter,
      retryAfterSec: 15,
    });
    expect(out.nextStep).toContain(`until ${pollUntil}`);
    // Counted from the first call, not from each.
    vi.setSystemTime(NOW + 60_000);
    expect((await track({ txHash: TX, quoteId })).out.pollUntil).toBe(pollUntil);
    vi.setSystemTime(Date.parse(pollUntil) + 1000);
    const asked = (await track({ txHash: TX, quoteId })).out;
    expect(asked).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: false, stopAfter });
    expect(asked.pollUntil).toBeUndefined();
    // An agent going by retryAfterSec calls next once it's past stopAfter, not every 15 seconds until then.
    expect(Date.now() + asked.retryAfterSec * 1000).toBeGreaterThan(Date.parse(stopAfter));
    expect(asked.nextStep).toContain("stop calling on a timer: ask the user to check their wallet");
    expect(asked.nextStep).not.toContain("nothing was swapped");
    vi.setSystemTime(Date.parse(stopAfter) + 1000);
    expect((await track({ txHash: TX, quoteId })).out.status).toBe("source_not_found");
  });

  it("is polled no longer than until the quote's deadline plus the 5 minutes a late tx gets", async () => {
    stubBackend();
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    const { out } = await track({ txHash: TX, quoteId: cacheQuote().quoteId });
    const stopAfter = new Date(Number(DEADLINE) * 1000 + 5 * 60 * 1000).toISOString();
    expect(out).toMatchObject({ pollUntil: stopAfter, stopAfter });
  });
});
