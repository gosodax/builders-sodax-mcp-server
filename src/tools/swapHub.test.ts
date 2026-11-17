import { spokeChainConfig } from "@sodax/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import { getEvmReceipt, hubIntentClosed, initSodax, intentHash, isTxKnown, userHubWallet } from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { hubReceipt } from "../services/swap/__fixtures__/deposit.js";
import { clearAlerts } from "../services/swap/alerts.js";
import { claimDeposit, clearQuoteCache } from "../services/swap/quoteCache.js";
import { INTENT_CANCELLED_TOPIC, INTENT_CREATED_TOPIC } from "../services/swap/sourceTx.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { clearUnseenMemo, trackWait } from "../services/swap/track.js";
import {
  CREATOR,
  DEADLINE,
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
  return { ...actual, getEvmReceipt: vi.fn(), hubIntentClosed: vi.fn(), isTxKnown: vi.fn(), userHubWallet: vi.fn() };
});

const SONIC_TX = `0x${"5".repeat(64)}`;
const OTHER_TX = `0x${"6".repeat(64)}`;
const CANCEL_TX = `0x${"c".repeat(64)}`;
// A swap from the hub: its source is the hub's relay id, and the sender's router is the creator.
const HUB_INTENT = { ...INTENT, srcChain: "146", dstChain: "23" };
await initSodax();
const HASH = intentHash(HUB_INTENT).toLowerCase();
const OTHER_HASH = `0x${"9".repeat(64)}`;

const track = (args: Record<string, unknown>) => callTool("sodax_swap_submit_and_track", args);
const cancel = (args: Record<string, unknown>) => callTool("sodax_swap_cancel", args);
const submits = (calls: { path: string }[]) => calls.filter(call => call.path === "/submit-tx");
const relays = (calls: { path: string }[]) => calls.filter(call => call.path === "/intents/submit");

const hubQuote = () =>
  cacheQuote({
    srcChainKey: "sonic",
    dstChainKey: "0xa4b1.arbitrum",
    intent: HUB_INTENT,
    relayData: { address: CREATOR, payload: "0x" },
  });

beforeEach(() => {
  Object.assign(trackWait, { stepMs: 1, maxMs: 0 });
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearSwapCatalogCache();
  clearCache();
  clearQuoteCache();
  clearAlerts();
  clearUnseenMemo();
  // Mocks from the vi.mock factory keep their implementation across tests unless reset here.
  for (const mock of [getEvmReceipt, hubIntentClosed, isTxKnown, userHubWallet]) vi.mocked(mock).mockReset();
  vi.mocked(isTxKnown).mockResolvedValue(true);
  vi.mocked(hubIntentClosed).mockResolvedValue(false);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a swap from Sonic, the hub", () => {
  it("is submitted once its receipt holds the intents contract's IntentCreated for the quoted intent", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    const calls = stubBackend();
    const { out } = await track({ txHash: SONIC_TX, quoteId: hubQuote().quoteId });
    expect(out).toMatchObject({ status: "queued", chain: { key: "sonic" }, intentHash: HASH });
    expect(getEvmReceipt).toHaveBeenCalledWith("sonic", SONIC_TX);
    expect(submits(calls)).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ txHash: SONIC_TX, srcChainKey: "sonic" }) }),
    ]);
  });

  it.each([
    // The log names no sender, so another intent may be anyone's: no alert either way.
    ["another intent", [OTHER_HASH], undefined, { reason: "not_a_deposit" }],
    ["no intent", [], undefined, { reason: "not_a_deposit" }],
    ["the quoted intent logged by another contract", [HASH], USER, { reason: "not_a_deposit" }],
    [
      "two intents, the quoted one among them",
      [HASH, OTHER_HASH],
      undefined,
      { reason: "multiple_deposits", alerted: false },
    ],
  ])("isn't submitted when the tx created %s", async (_case, hashes, from, expected) => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, hashes, from));
    const calls = stubBackend();
    const { out } = await track({ txHash: SONIC_TX, quoteId: hubQuote().quoteId });
    expect(out).toMatchObject({ status: "not_submitted", ...expected });
    expect(submits(calls)).toEqual([]);
  });

  it("isn't relayed past its deadline: the intent is on the hub, and the canceller refunds it", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    const calls = stubBackend();
    const { quoteId } = hubQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    const { out } = await track({ txHash: SONIC_TX, quoteId });
    // Left to the canceller, not relayed: it waits for its refund, which the user can take sooner with a cancel.
    expect(out.status).toBe("expired_awaiting_refund");
    expect(out.nextStep).toContain("unless a solver filled it first");
    expect(out.nextStep).toContain("cancel it now with sodax_swap_cancel");
    expect(relays(calls)).toEqual([]);
    expect(submits(calls)).toEqual([]);
  });

  it("waits for its deadline when refused near it: only an expired hub intent is refunded", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    const calls = stubBackend({ row: null, submit: () => Response.json({ message: "refused" }, { status: 400 }) });
    const { quoteId } = hubQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 - 60_000);
    const { out } = await track({ txHash: SONIC_TX, quoteId });
    expect(out).toMatchObject({ status: "submit_refused", alerted: false });
    // No operator recovers a hub intent: the expiry does.
    expect(out.nextStep).toContain("unless a solver fills it first, it's refunded to them once its quote expires");
    expect(out.nextStep).not.toContain("SODAX support");
    expect(relays(calls)).toEqual([]);
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("expired_awaiting_refund");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("isn't submitted once its intent is gone from the hub, cancelled elsewhere or filled", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    vi.mocked(hubIntentClosed).mockResolvedValue(true);
    const calls = stubBackend({ row: null });
    const { quoteId } = hubQuote();
    const { out } = await track({ txHash: SONIC_TX, quoteId });
    expect(out).toMatchObject({ status: "intent_closed", intentHash: HASH });
    // A tool every connection with the swap tools has.
    expect(out.nextStep).toContain("sodax_get_balance");
    // Read at or past the block of the tx that created the intent, so a node behind it can't pass for this.
    expect(hubIntentClosed).toHaveBeenCalledWith(HASH, SONIC_TX);
    expect(submits(calls)).toEqual([]);
    // Remembered by track, which never asks the hub again.
    expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("intent_closed");
    expect(hubIntentClosed).toHaveBeenCalledTimes(1);
  });

  it("is submitted when the hub can't be read: the check only spares a pointless submit", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    vi.mocked(hubIntentClosed).mockRejectedValue(new Error("SDK call failed"));
    const calls = stubBackend();
    const { out } = await track({ txHash: SONIC_TX, quoteId: hubQuote().quoteId });
    expect(out.status).toBe("queued");
    expect(submits(calls)).toHaveLength(1);
  });

  it("confirms the user's own cancel though track found the intent closed before the confirming call", async () => {
    vi.mocked(getEvmReceipt).mockImplementation(async (_chain, txHash) =>
      txHash === CANCEL_TX ? hubReceipt(INTENT_CANCELLED_TOPIC, [HASH]) : hubReceipt(INTENT_CREATED_TOPIC, [HASH]),
    );
    stubBackend({ row: null });
    const { quoteId } = hubQuote();
    expect((await cancel({ txHash: SONIC_TX, quoteId })).out.status).toBe("ready");
    // The cancel is mined; the agent tracks before confirming it.
    vi.mocked(hubIntentClosed).mockResolvedValue(true);
    expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("intent_closed");
    const { out } = await cancel({ txHash: SONIC_TX, quoteId, cancelTxHash: CANCEL_TX });
    expect(out.status).toBe("cancel_confirmed");
    expect((await track({ txHash: SONIC_TX, quoteId })).out).toMatchObject({ status: "failed", outcome: "cancelled" });
  });

  it("past its deadline, reports a refund only while the hub holds the intent", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    stubBackend({ row: null });
    const { quoteId } = hubQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("expired_awaiting_refund");
    // The canceller refunded it since: no cancel is offered, and none is built.
    vi.mocked(hubIntentClosed).mockResolvedValue(true);
    expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("intent_closed");
    const { out } = await cancel({ txHash: SONIC_TX, quoteId });
    expect(out).toMatchObject({ status: "not_cancellable", reason: "closed", intentHash: HASH });
  });

  it("found closed, never offers a cancel from a lagging row, but reports its fill once solved", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    vi.mocked(hubIntentClosed).mockResolvedValue(true);
    const { quoteId } = hubQuote();
    claimDeposit(quoteId, SONIC_TX);
    stubBackend({ row: { status: "failed", result: { dstIntentTxHash: SONIC_TX } } });
    expect((await cancel({ txHash: SONIC_TX, quoteId })).out).toMatchObject({ reason: "closed" });
    const { out } = await track({ txHash: SONIC_TX, quoteId });
    expect(out.status).toBe("intent_closed");
    expect(out).not.toHaveProperty("canCancel");
    stubBackend({ row: { status: "solved", result: { dstIntentTxHash: SONIC_TX } } });
    expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("solved");
  });

  it("pages no one for a second tx of the same quote", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    stubBackend({ row: null });
    const { quoteId } = hubQuote();
    claimDeposit(quoteId, OTHER_TX);
    const { out } = await track({ txHash: SONIC_TX, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "quote_used", alerted: false });
  });

  it("is reported, not submitted, without its quote, and pages no one", async () => {
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
    const calls = stubBackend();
    const { out } = await track({ txHash: SONIC_TX, chain: "sonic", quoteId: "6f1c7e1e-9d2a-4f5b-8c3d-2e4a6b8c0d1e" });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false });
    expect(submits(calls)).toEqual([]);
  });

  describe("cancelled", () => {
    const row = { status: "failed", result: { dstIntentTxHash: SONIC_TX } };
    const cancellable = () => {
      const { quoteId } = hubQuote();
      claimDeposit(quoteId, SONIC_TX);
      return quoteId;
    };

    it("through the user's wallet router on Sonic, with no value", async () => {
      stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: cancellable() });
      expect(out.status).toBe("ready");
      expect(out.steps).toEqual([
        {
          kind: "cancel",
          chainId: 146,
          tx: expect.objectContaining({
            from: HUB_INTENT.srcAddress,
            to: spokeChainConfig.sonic.addresses.walletRouter,
            value: "0x0",
            chainId: "0x92",
          }),
        },
      ]);
    });

    // The swap tx logged the intent, and a cancel, mined after it unless `cancelBlock` says otherwise, logged its
    // cancellation.
    const onChain = (cancelled: string[], cancelBlock?: bigint) =>
      vi
        .mocked(getEvmReceipt)
        .mockImplementation(async (_chain, txHash) =>
          txHash === CANCEL_TX
            ? hubReceipt(INTENT_CANCELLED_TOPIC, cancelled, undefined, cancelBlock)
            : hubReceipt(INTENT_CREATED_TOPIC, [HASH]),
        );

    it("is confirmed by the intents contract's IntentCancelled for the intent, with no relay", async () => {
      onChain([HASH]);
      const calls = stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: cancellable(), cancelTxHash: CANCEL_TX });
      expect(out.status).toBe("cancel_confirmed");
      expect(getEvmReceipt).toHaveBeenCalledWith("sonic", CANCEL_TX);
      expect(relays(calls)).toEqual([]);
    });

    // A cancelled intent is deleted from the hub, so the same one may be created again: its old cancel isn't this one's.
    it("isn't confirmed by a cancel mined before the swap that created the intent, which isn't then reported cancelled", async () => {
      onChain([HASH], 99n);
      const calls = stubBackend({ row: null });
      const { quoteId } = hubQuote();
      const { out } = await cancel({ txHash: SONIC_TX, quoteId, cancelTxHash: CANCEL_TX });
      expect(out.status).toBe("not_a_cancel_tx");
      expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("queued");
      expect(submits(calls)).toHaveLength(1);
    });

    it("waits for a node that has the swap's tx to order the cancel after it", async () => {
      vi.mocked(getEvmReceipt).mockImplementation(async (_chain, txHash) =>
        txHash === CANCEL_TX ? hubReceipt(INTENT_CANCELLED_TOPIC, [HASH]) : null,
      );
      stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: cancellable(), cancelTxHash: CANCEL_TX });
      expect(out).toMatchObject({ status: "cancel_awaiting_confirmation", retryAfterSec: 15 });
    });

    it("is built without its quote for an intent the tracked tx created, by the sender's router", async () => {
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, [HASH]));
      vi.mocked(userHubWallet).mockResolvedValue(CREATOR);
      stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, chain: "sonic" });
      expect(out.status).toBe("ready");
      expect(userHubWallet).toHaveBeenCalledWith("sonic", HUB_INTENT.srcAddress);
    });

    it.each([
      ["the tracked tx created another intent", [OTHER_HASH], CREATOR],
      ["its creator isn't the sender's router", [HASH], USER],
    ])("isn't built without its quote when %s", async (_case, hashes, router) => {
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, hashes));
      vi.mocked(userHubWallet).mockResolvedValue(router);
      stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, chain: "sonic" });
      expect(out.error.code).toBe("SWAP_MISMATCH");
    });

    it("is cancelled straight from its quote before the swap service has it, and then reported cancelled", async () => {
      onChain([HASH]);
      stubBackend({ row: null });
      const { quoteId } = hubQuote();
      const ready = await cancel({ txHash: SONIC_TX, quoteId });
      expect(ready.out).toMatchObject({ status: "ready", steps: [{ kind: "cancel", chainId: 146 }] });
      const confirmed = await cancel({ txHash: SONIC_TX, quoteId, cancelTxHash: CANCEL_TX });
      expect(confirmed.out.status).toBe("cancel_confirmed");
      // Its quote remembers: track doesn't submit a cancelled intent, and a second cancel has nothing left to do.
      expect((await track({ txHash: SONIC_TX, quoteId })).out).toMatchObject({
        status: "failed",
        outcome: "cancelled",
      });
      expect((await cancel({ txHash: SONIC_TX, quoteId })).out).toMatchObject({ reason: "cancelled" });
    });

    it("is cancelled from its quote past its deadline too: the user needn't wait for the canceller", async () => {
      onChain([HASH]);
      stubBackend({ row: null });
      const { quoteId } = hubQuote();
      vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
      expect((await cancel({ txHash: SONIC_TX, quoteId })).out.status).toBe("ready");
    });

    it("is built from its quote while the swap service has a row but no intent for it yet", async () => {
      onChain([HASH]);
      stubBackend({ row: { status: "pending" } });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: hubQuote().quoteId });
      expect(out.status).toBe("ready");
    });

    it("asks for the swap tx when given another tx with its quote, an approval say", async () => {
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CREATED_TOPIC, []));
      stubBackend({ row: null });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: hubQuote().quoteId });
      expect(out).toMatchObject({ status: "not_cancellable", reason: "not_this_swap" });
      expect(out.nextStep).toContain("ask for the swap transaction's hash");
    });

    it("isn't built once the hub no longer holds the intent: that cancel would revert", async () => {
      onChain([HASH]);
      vi.mocked(hubIntentClosed).mockResolvedValue(true);
      stubBackend({ row: null });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: hubQuote().quoteId });
      expect(out).toMatchObject({ status: "not_cancellable", reason: "closed" });
    });

    it("is reported cancelled once confirmed, though the backend row still says it can be cancelled", async () => {
      onChain([HASH]);
      stubBackend({ row, hubIntent: HUB_INTENT });
      const quoteId = cancellable();
      expect((await cancel({ txHash: SONIC_TX, quoteId, cancelTxHash: CANCEL_TX })).out.status).toBe(
        "cancel_confirmed",
      );
      expect((await track({ txHash: SONIC_TX, quoteId })).out).toMatchObject({
        status: "failed",
        outcome: "cancelled",
        canCancel: false,
      });
      expect((await cancel({ txHash: SONIC_TX, quoteId })).out).toMatchObject({ reason: "cancelled" });
    });

    it("isn't confirmed early by a tx that cancelled another intent", async () => {
      onChain([OTHER_HASH]);
      stubBackend({ row: null });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: hubQuote().quoteId, cancelTxHash: CANCEL_TX });
      expect(out.status).toBe("not_a_cancel_tx");
    });

    it("says, without its quote or a backend row, that an intent on Sonic is refunded once expired", async () => {
      stubBackend({ row: null });
      const { out } = await cancel({ txHash: SONIC_TX, chain: "sonic" });
      expect(out).toMatchObject({ status: "not_cancellable", reason: "not_submitted" });
      expect(out.nextStep).toContain("its intent is there already");
      expect(out.nextStep).not.toContain("call sodax_swap_submit_and_track");
    });

    it("isn't confirmed by a tx that cancelled another intent", async () => {
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CANCELLED_TOPIC, [OTHER_HASH]));
      stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: cancellable(), cancelTxHash: CANCEL_TX });
      expect(out.status).toBe("not_a_cancel_tx");
    });
  });
});
