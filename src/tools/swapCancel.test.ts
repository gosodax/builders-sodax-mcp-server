import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import { cancelPayload, getEvmReceipt, initSodax } from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { fixtureText } from "../services/swap/__fixtures__/catalog.js";
import { abiEncode } from "../services/swap/__fixtures__/encode.js";
import { claimDeposit, clearQuoteCache, markRelayedForRefund } from "../services/swap/quoteCache.js";
import { SEND_MESSAGE_SELECTOR } from "../services/swap/sourceTx.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import {
  ARBITRUM,
  CONNECTION,
  CREATOR,
  INTENT,
  NOW,
  TX,
  USER,
  cacheQuote,
  callTool,
  cancelReceipt,
  stubBackend,
} from "./__fixtures__/swapBackend.js";

vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return { ...actual, getEvmReceipt: vi.fn(), isTxKnown: vi.fn() };
});

const HUB_TX = `0x${"b".repeat(64)}`;
const CANCEL_TX = `0x${"d".repeat(64)}`;
// What the user's hub wallet runs: the SDK's cancelIntent(INTENT), the only payload a cancel may carry.
await initSodax();
const PAYLOAD = cancelPayload(INTENT) ?? "";
const OPEN = { status: "failed", result: { dstIntentTxHash: HUB_TX } };
/** The cancel the backend builds for INTENT: the user's `sendMessage` to their hub wallet. */
const CANCEL_TX_BUILT = {
  from: USER,
  to: CONNECTION,
  value: "0",
  data: `${SEND_MESSAGE_SELECTOR}${abiEncode([146n, CREATOR, PAYLOAD]).slice(2)}`,
};
const cancel = (args: Record<string, unknown>) => callTool("sodax_swap_cancel", args);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearSwapCatalogCache();
  clearCache();
  clearQuoteCache();
  vi.mocked(getEvmReceipt).mockResolvedValue(cancelReceipt(PAYLOAD));
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(getEvmReceipt).mockReset();
});

describe("sodax_swap_cancel", () => {
  it.each([
    [null, "not_submitted"],
    [{ status: "solved", result: { dstIntentTxHash: HUB_TX } }, "solved"],
    [{ ...OPEN, intentCancelled: true }, "cancelled"],
    [{ ...OPEN, relayedForRefundAt: "2026-10-26T12:00:00Z" }, "refunding"],
    [{ status: "relaying" }, "not_on_hub_yet"],
  ])("has nothing to cancel for %o", async (row, reason) => {
    const calls = stubBackend({ row });
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM });
    expect(out).toMatchObject({ status: "not_cancellable", reason });
    expect(calls.map(call => call.path).filter(path => !path.startsWith("/submit-tx/status"))).toEqual([]);
  });

  it("returns the checked cancel for the user's wallet, built from the hub's intent", async () => {
    const calls = stubBackend({ row: OPEN, cancelTx: CANCEL_TX_BUILT });
    const { out } = await cancel({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out).toMatchObject({
      status: "ready",
      steps: [{ kind: "cancel", chainId: 42161, tx: { ...CANCEL_TX_BUILT, value: "0x0" } }],
    });
    expect(out.nextStep).toContain("call sodax_swap_cancel again with the same arguments plus cancelTxHash");
    expect(calls.find(call => call.path === "/intents/cancel")?.body).toEqual({
      srcChainKey: ARBITRUM,
      intent: INTENT,
    });
  });

  it("builds the cancel for the SDK config's chain id though the live one differs", async () => {
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    configs[ARBITRUM].chain.chainId = 8453;
    stubBackend({ row: OPEN, cancelTx: CANCEL_TX_BUILT, configs: JSON.stringify(configs) });
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM });
    expect(out).toMatchObject({ status: "ready", steps: [{ kind: "cancel", chainId: 42161 }] });
  });

  it.each([
    ["another contract", { to: USER }],
    ["another sender", { from: CREATOR }],
    ["a value", { value: "1" }],
    ["a message to someone else", { data: `${SEND_MESSAGE_SELECTOR}${abiEncode([146n, USER, PAYLOAD]).slice(2)}` }],
    [
      "other calls for the hub wallet",
      { data: `${SEND_MESSAGE_SELECTOR}${abiEncode([146n, CREATOR, `${PAYLOAD}00`]).slice(2)}` },
    ],
    [
      "another intent's cancel",
      {
        data: `${SEND_MESSAGE_SELECTOR}${abiEncode([146n, CREATOR, cancelPayload({ ...INTENT, intentId: "8" }) ?? ""]).slice(2)}`,
      },
    ],
    ["another function", { data: `0xa9059cbb${abiEncode([146n, CREATOR, PAYLOAD]).slice(2)}` }],
  ])("refuses a built cancel with %s", async (_case, change) => {
    stubBackend({ row: OPEN, cancelTx: { ...CANCEL_TX_BUILT, ...change } });
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM });
    expect(out.error.code).toBe("SWAP_MISMATCH");
  });

  it.each([
    { intentId: "8" },
    { minOutputAmount: "1" },
    { dstAddress: CREATOR },
    { deadline: "1" },
    { allowPartialFill: true },
  ])("refuses a hub intent that isn't the quoted one (%o)", async change => {
    const calls = stubBackend({ row: OPEN, hubIntent: { ...INTENT, ...change }, cancelTx: CANCEL_TX_BUILT });
    const { out } = await cancel({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out.error.code).toBe("SWAP_MISMATCH");
    expect(calls.some(call => call.path === "/intents/cancel")).toBe(false);
  });

  it("takes the hub's copy of the quoted intent in another hex case", async () => {
    stubBackend({
      row: OPEN,
      hubIntent: { ...INTENT, inputToken: INTENT.inputToken.toLowerCase() },
      cancelTx: CANCEL_TX_BUILT,
    });
    const { out } = await cancel({ txHash: TX, quoteId: cacheQuote().quoteId });
    expect(out.status).toBe("ready");
  });

  it("calls a deposit this server relayed for refund already refunding, though the backend has no row", async () => {
    stubBackend({ row: null });
    const quote = cacheQuote();
    const { quoteId } = quote;
    claimDeposit(quoteId, TX);
    markRelayedForRefund(quote);
    const { out } = await cancel({ txHash: TX, quoteId });
    expect(out).toMatchObject({ status: "not_cancellable", reason: "refunding" });
    expect(out.nextStep).toContain("already being refunded");
  });

  it("relays the user's sent cancel once it's on chain, without asking the cancel endpoint again", async () => {
    // No cancelTx: the stub's cancel endpoint answers with nothing usable.
    const calls = stubBackend({ row: OPEN });
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM, cancelTxHash: CANCEL_TX });
    expect(out.status).toBe("cancel_relayed");
    expect(getEvmReceipt).toHaveBeenCalledWith(ARBITRUM, CANCEL_TX);
    expect(calls.find(call => call.path === "/intents/submit")?.body).toEqual({ chainId: "23", txHash: CANCEL_TX });
    expect(calls.some(call => call.path === "/intents/cancel")).toBe(false);
  });

  it("calls a quote whose deposit is another tx a mismatch, before reading anything, without an error log", async () => {
    const calls = stubBackend({ row: OPEN, cancelTx: CANCEL_TX_BUILT });
    const { quoteId } = cacheQuote();
    claimDeposit(quoteId, `0x${"e".repeat(64)}`);
    const { out } = await cancel({ txHash: TX, quoteId });
    expect(out.error.code).toBe("QUOTE_MISMATCH");
    expect(out.nextStep).toBe(
      "Call again with the quoteId this transaction was made from, or with chain instead of quoteId.",
    );
    expect(calls).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    [null, "cancel_awaiting_confirmation"],
    [{ ...cancelReceipt(PAYLOAD), reverted: true }, "cancel_failed"],
    [cancelReceipt("0x01"), "not_a_cancel_tx"],
    [cancelReceipt(PAYLOAD, CREATOR), "not_a_cancel_tx"],
  ])("doesn't relay a cancel that isn't there (%#)", async (receipt, status) => {
    const calls = stubBackend({ row: OPEN, cancelTx: CANCEL_TX_BUILT });
    vi.mocked(getEvmReceipt).mockResolvedValue(receipt);
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM, cancelTxHash: CANCEL_TX });
    expect(out.status).toBe(status);
    expect(calls.some(call => call.path === "/intents/submit")).toBe(false);
  });

  it("asks the backend only for the swap's status until the cancel is mined", async () => {
    const calls = stubBackend({ row: OPEN, cancelTx: CANCEL_TX_BUILT });
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM, cancelTxHash: CANCEL_TX });
    expect(out.status).toBe("cancel_awaiting_confirmation");
    expect(calls.map(call => call.path.split("?")[0])).toEqual(["/submit-tx/status"]);
  });

  it("says a never-submitted swap has nothing to cancel, without waiting for the sent cancel", async () => {
    stubBackend({ row: null });
    vi.mocked(getEvmReceipt).mockResolvedValue(null);
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM, cancelTxHash: CANCEL_TX });
    expect(out).toMatchObject({ status: "not_cancellable", reason: "not_submitted" });
    expect(getEvmReceipt).not.toHaveBeenCalled();
  });

  it("asks for a retry when the relay doesn't take the cancel", async () => {
    stubBackend({
      row: OPEN,
      cancelTx: CANCEL_TX_BUILT,
      relay: () => Response.json({ result: { success: false, message: "" } }),
    });
    const { out } = await cancel({ txHash: TX, chain: ARBITRUM, cancelTxHash: CANCEL_TX });
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(out.nextStep).toContain("Call sodax_swap_cancel again in 30 seconds");
  });
});
