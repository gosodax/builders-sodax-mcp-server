import { spokeChainConfig } from "@sodax/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import { type EvmReceipt, getEvmReceipt, initSodax, intentHash, isTxKnown } from "../services/sodax.js";
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
  return { ...actual, getEvmReceipt: vi.fn(), isTxKnown: vi.fn() };
});

const SONIC_TX = `0x${"5".repeat(64)}`;
const CANCEL_TX = `0x${"c".repeat(64)}`;
// A swap from the hub: its source is the hub's relay id, and the sender's router is the creator.
const HUB_INTENT = { ...INTENT, srcChain: "146", dstChain: "23" };
await initSodax();
const HASH = intentHash(HUB_INTENT).toLowerCase();
const OTHER_HASH = `0x${"9".repeat(64)}`;

const track = (args: Record<string, unknown>) => callTool("sodax_swap_track", args);
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
  vi.mocked(isTxKnown).mockResolvedValue(true);
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
    expect(out.status).toBe("expired_refunding");
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
    expect(relays(calls)).toEqual([]);
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    expect((await track({ txHash: SONIC_TX, quoteId })).out.status).toBe("expired_refunding");
    expect(logger.error).not.toHaveBeenCalled();
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
            to: spokeChainConfig.sonic.addresses.walletRouter,
            value: "0x0",
            chainId: "0x92",
          }),
        },
      ]);
    });

    it("is confirmed by the intents contract's IntentCancelled for the intent, with no relay", async () => {
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CANCELLED_TOPIC, [HASH]));
      const calls = stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: cancellable(), cancelTxHash: CANCEL_TX });
      expect(out.status).toBe("cancel_confirmed");
      expect(getEvmReceipt).toHaveBeenCalledWith("sonic", CANCEL_TX);
      expect(relays(calls)).toEqual([]);
    });

    it("isn't confirmed by a tx that cancelled another intent", async () => {
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt(INTENT_CANCELLED_TOPIC, [OTHER_HASH]));
      stubBackend({ row, hubIntent: HUB_INTENT });
      const { out } = await cancel({ txHash: SONIC_TX, quoteId: cancellable(), cancelTxHash: CANCEL_TX });
      expect(out.status).toBe("not_a_cancel_tx");
    });
  });
});
