import { keccak_256 } from "@noble/hashes/sha3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import {
  assetManagerMarker,
  buildNonEvmCancel,
  cancelPayload,
  createIntentPayload,
  getEvmReceipt,
  initSodax,
  readNonEvmTx,
  userHubWallet,
} from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { clearAlerts } from "../services/swap/alerts.js";
import type { NonEvmTx } from "../services/swap/nonEvmSource.js";
import { claimDeposit, clearQuoteCache } from "../services/swap/quoteCache.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { clearUnseenMemo, trackWait } from "../services/swap/track.js";
import { CREATOR, DEADLINE, INTENT, NOW, cacheQuote, callTool, stubBackend } from "./__fixtures__/swapBackend.js";

// Unit tests don't reach a chain: the source txs and the SDK's cancel build are scripted per test.
vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return {
    ...actual,
    getEvmReceipt: vi.fn(),
    readNonEvmTx: vi.fn(),
    buildNonEvmCancel: vi.fn(),
    userHubWallet: vi.fn(),
    assetManagerMarker: vi.fn(actual.assetManagerMarker),
  };
});

await initSodax();

const SUI_USER = `0x${"5".repeat(64)}`;
// A Sui digest and a Solana signature, as their wallets show them: base58, so case matters.
const SUI_TX = "An29uC4D2bZimbEmWoWgsHArPgc1vgfQQNwsSks9mA63";
const SOLANA_TX = "DfcrzDf8SEv2C5uxXvBtBXhSVWBy79ydLbpEefhLaT5wmR4vbrHbCpZkcmNWtPjAMK2aHZgbTCaToCMuzr8VhS7";
const HUB_TX = `0x${"b".repeat(64)}`;
const PAYLOAD = `0x${"ab".repeat(40)}`;
const SUI_INTENT = { ...INTENT, srcChain: "21", srcAddress: SUI_USER };
const SOLANA_INTENT = { ...INTENT, srcChain: "1", srcAddress: `0x${"7".repeat(64)}` };

const track = (args: Record<string, unknown>) => callTool("sodax_swap_track", args);
const cancel = (args: Record<string, unknown>) => callTool("sodax_swap_cancel", args);
const submits = (calls: { path: string; body?: Record<string, unknown> }[]) =>
  calls.filter(call => call.path === "/submit-tx");
const relays = (calls: { path: string; body?: Record<string, unknown> }[]) =>
  calls.filter(call => call.path === "/intents/submit");

const suiQuote = () =>
  cacheQuote({
    srcChainKey: "sui",
    srcAddress: SUI_USER,
    intent: SUI_INTENT,
    relayData: { address: CREATOR, payload: PAYLOAD },
  });
const solanaQuote = () =>
  cacheQuote({
    srcChainKey: "solana",
    srcAddress: "7".repeat(44),
    intent: SOLANA_INTENT,
    relayData: { address: CREATOR, payload: PAYLOAD },
  });
const NEAR_TX = "FJhdNpwGRwJLiFExdXWj73rDUC2YMBGiTr3RFrJgYCgc";
const nearQuote = () =>
  cacheQuote({
    srcChainKey: "near",
    srcAddress: "alice.near",
    intent: { ...INTENT, srcChain: "15" },
    relayData: { address: CREATOR, payload: PAYLOAD },
  });
/** A ran NEAR deposit signed by `signer`, carrying `held` in its args as NEAR's asset manager takes data. */
const nearTx = (signer: string, held = PAYLOAD): NonEvmTx => ({
  failed: false,
  bytes: new Uint8Array(),
  calls: [{ contract: "asset-manager.sodax.near", args: { data: [...Buffer.from(held.slice(2), "hex")] } }],
  signer,
});
/** A ran tx on Sui (or Solana) whose signed bytes hold `held` as its family does, calling the asset manager unless told not to. */
const ranTx = (held: string, { failed = false, chainKey = "sui", deposit = true } = {}): NonEvmTx => {
  const family = chainKey === "sui" ? "SUI" : "SOLANA";
  const marker = deposit ? (assetManagerMarker(chainKey, family) as Uint8Array) : new Uint8Array();
  // Solana's tx commits only the payload's keccak.
  const bytes = Buffer.from(held.slice(2), "hex");
  const signed = family === "SOLANA" ? keccak_256(bytes) : bytes;
  return { failed, bytes: Buffer.concat([marker, signed, Buffer.from([4])]), calls: [] };
};

beforeEach(() => {
  Object.assign(trackWait, { stepMs: 1, maxMs: 0 });
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearSwapCatalogCache();
  clearCache();
  clearQuoteCache();
  clearAlerts();
  clearUnseenMemo();
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(trackWait, { stepMs: 5_000, maxMs: 20_000 });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(readNonEvmTx).mockReset();
  vi.mocked(buildNonEvmCancel).mockReset();
});

describe("a swap from a non-EVM spoke", () => {
  it("is submitted once its tx carries the quoted payload, keyed on the hash as its wallet spells it", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(PAYLOAD));
    const calls = stubBackend();
    const { out } = await track({ txHash: SUI_TX, quoteId: suiQuote().quoteId });
    expect(out).toMatchObject({ status: "queued", txHash: SUI_TX, chain: { key: "sui" } });
    expect(readNonEvmTx).toHaveBeenCalledWith("sui", "SUI", SUI_TX, SUI_USER);
    expect(submits(calls)).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ txHash: SUI_TX, srcChainKey: "sui", relayData: PAYLOAD }),
      }),
    ]);
    expect(getEvmReceipt).not.toHaveBeenCalled();
  });

  it("isn't submitted when its tx carries the payload but never calls the asset manager", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(PAYLOAD, { deposit: false }));
    const calls = stubBackend();
    const { out } = await track({ txHash: SUI_TX, quoteId: suiQuote().quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "not_a_deposit" });
    expect(submits(calls)).toEqual([]);
  });

  it("isn't submitted when its deposit carries another payload: another quote's, which alerts", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(`0x${"cd".repeat(40)}`));
    const calls = stubBackend();
    const { out } = await track({ txHash: SUI_TX, quoteId: suiQuote().quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch" });
    // Its sender isn't decoded, so it isn't called the user's.
    expect(out.nextStep).toContain("can't tell who sent it");
    expect(out.nextStep).toContain("ask for this swap's transaction hash");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "other_quote_deposit" }),
      expect.any(String),
    );
    expect(submits(calls)).toEqual([]);
  });

  it("isn't submitted when a NEAR wallet sent the deposit from another account than the quoted one", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(nearTx("bob.near"));
    const calls = stubBackend();
    const { out } = await track({ txHash: NEAR_TX, quoteId: nearQuote().quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "other_sender" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "other_sender_deposit" }),
      expect.any(String),
    );
    expect(submits(calls)).toEqual([]);
  });

  it("calls someone else's NEAR deposit without this quote's payload not this quote's, and alerts no one", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(nearTx("bob.near", `0x${"cd".repeat(40)}`));
    const calls = stubBackend();
    const { out } = await track({ txHash: NEAR_TX, quoteId: nearQuote().quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "not_a_deposit" });
    expect(logger.error).not.toHaveBeenCalled();
    expect(submits(calls)).toEqual([]);
  });

  it("isn't submitted when an Injective wallet sent the deposit from another account than the quoted one", async () => {
    const quote = cacheQuote({
      srcChainKey: "injective-1",
      srcAddress: "inj1q8t36glg95q42rv2j4xm7gk79y9zhd2de8fdmt",
      intent: { ...INTENT, srcChain: "19" },
      relayData: { address: CREATOR, payload: PAYLOAD },
    });
    const data = [...Buffer.from(PAYLOAD.slice(2), "hex")];
    const calls = [{ contract: "inj1dg6tm62uup53wn2kn97caeqfwt0sukx3qjk8rw", args: { transfer: { data } } }];
    vi.mocked(readNonEvmTx).mockResolvedValue({ failed: false, bytes: new Uint8Array(), calls, signer: "inj1other" });
    const backend = stubBackend();
    const { out } = await track({
      txHash: "AC4D677E8C4FDAB97FE347E2276A8037B046A2B6482FE73A101F04742D616A96",
      quoteId: quote.quoteId,
    });
    expect(out).toMatchObject({ status: "not_submitted", reason: "other_sender" });
    expect(submits(backend)).toEqual([]);
  });

  it("submits a NEAR deposit signed by the quoted account", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(nearTx("alice.near"));
    const calls = stubBackend();
    const { out } = await track({ txHash: NEAR_TX, quoteId: nearQuote().quoteId });
    expect(out.status).toBe("queued");
    expect(submits(calls)).toHaveLength(1);
  });

  it("is reported failed when its tx failed, even carrying the payload", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(PAYLOAD, { failed: true }));
    const calls = stubBackend();
    const { out } = await track({ txHash: SUI_TX, quoteId: suiQuote().quoteId });
    expect(out.status).toBe("source_failed");
    expect(submits(calls)).toEqual([]);
  });

  it("is waited for while its chain doesn't know it, until the quote's stop time", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(null);
    stubBackend();
    const { out } = await track({ txHash: SUI_TX, quoteId: suiQuote().quoteId });
    expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: false });
    expect(out.stopAfter).toBe(new Date(Number(DEADLINE) * 1000 + 5 * 60_000).toISOString());
    // Its node can't say whether it knows a tx still in flight.
    expect(out.nextStep).toContain("Sui hasn't confirmed this transaction yet");
  });

  it("refuses a hash that can't be its chain's, before reading anything", async () => {
    const calls = stubBackend();
    const { out } = await track({ txHash: `0x${"a".repeat(64)}`, quoteId: suiQuote().quoteId });
    expect(out.error).toMatchObject({ code: "INVALID_TX_HASH", format: "a base58 digest" });
    expect(readNonEvmTx).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("is relayed past its deadline for refund; from Solana with the relay data the tx committed the hash of", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(PAYLOAD, { chainKey: "solana" }));
    const calls = stubBackend();
    const { quoteId } = solanaQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    const { out } = await track({ txHash: SOLANA_TX, quoteId });
    expect(out.status).toBe("expired_refunding");
    expect(relays(calls)).toEqual([
      {
        path: "/intents/submit",
        body: { chainId: "1", txHash: SOLANA_TX, data: { address: CREATOR, payload: PAYLOAD } },
      },
    ]);
  });

  it("is relayed for refund from Sui with no relay data: the relay reads the deposit itself", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(PAYLOAD));
    const calls = stubBackend();
    const { quoteId } = suiQuote();
    vi.setSystemTime(Number(DEADLINE) * 1000 + 1000);
    await track({ txHash: SUI_TX, quoteId });
    expect(relays(calls)).toEqual([{ path: "/intents/submit", body: { chainId: "21", txHash: SUI_TX } }]);
  });

  it("is reported, not submitted, without its quote: a deposit if it calls the asset manager", async () => {
    const assetManager = Buffer.from("cb7346339340b7f8dea40fcafb70721dc2fcfa7e8626a89fd954d46c1f928b61", "hex");
    vi.mocked(readNonEvmTx).mockResolvedValue({ failed: false, bytes: assetManager, calls: [] });
    const calls = stubBackend();
    const { out } = await track({ txHash: SUI_TX, chain: "sui" });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false });
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(PAYLOAD, { deposit: false }));
    clearUnseenMemo();
    expect((await track({ txHash: SUI_TX, chain: "sui" })).out).toMatchObject({ isDeposit: false });
    expect(submits(calls)).toEqual([]);
  });

  it("doesn't say an unknown tx was never sent: public nodes drop old ones", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(null);
    stubBackend();
    const { out } = await track({ txHash: SUI_TX, chain: "sui" });
    expect(out.status).toBe("source_not_found");
    expect(out.nextStep).toContain("older than the node keeps");
    expect(out.nextStep).not.toContain("hasn't seen");
  });
});

describe("a swap from a non-EVM spoke, cancelled", () => {
  const row = { status: "failed", result: { dstIntentTxHash: HUB_TX } };
  const CANCEL_TX = "FushAhTwsQY8eqnFPVbjPXjZhM8kpAyHbK8JiG47FwCp";
  const claimed = (quote: { quoteId: string }, txHash: string) => {
    claimDeposit(quote.quoteId, txHash);
    return quote.quoteId;
  };

  it("is built by the SDK from the hub's intent, as the family's wallet takes it", async () => {
    vi.mocked(buildNonEvmCancel).mockResolvedValue({
      from: SUI_USER,
      to: "0xf3b1::connectionv3::send",
      value: 0n,
      data: "{}",
    });
    stubBackend({ row, hubIntent: SUI_INTENT });
    const { out } = await cancel({ txHash: SUI_TX, quoteId: claimed(suiQuote(), SUI_TX) });
    expect(out.status).toBe("ready");
    expect(out.steps).toEqual([
      {
        kind: "cancel",
        chainKey: "sui",
        chainType: "SUI",
        tx: { from: SUI_USER, to: "0xf3b1::connectionv3::send", value: "0", data: "{}" },
      },
    ]);
    expect(buildNonEvmCancel).toHaveBeenCalledWith("sui", SUI_INTENT);
    expect(out.nextStep).toContain("Transaction.from");
  });

  it("is built without its quote for the intent the tracked deposit carries, by its sender's hub wallet", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(createIntentPayload(SUI_INTENT) as string));
    vi.mocked(userHubWallet).mockResolvedValue(CREATOR);
    vi.mocked(buildNonEvmCancel).mockResolvedValue({ from: SUI_USER, to: "0xf3b1::connectionv3::send", data: "{}" });
    stubBackend({ row, hubIntent: SUI_INTENT });
    const { out } = await cancel({ txHash: SUI_TX, chain: "sui" });
    expect(out.status).toBe("ready");
    expect(userHubWallet).toHaveBeenCalledWith("sui", SUI_USER);
  });

  it("says, without its quote, when the node has dropped the deposit: calling again won't help", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(null);
    stubBackend({ row, hubIntent: SUI_INTENT });
    const { out } = await cancel({ txHash: SUI_TX, chain: "sui" });
    expect(out.error.code).toBe("QUOTE_NOT_FOUND");
    expect(out.nextStep).toContain("give SODAX support its transaction hash");
    expect(buildNonEvmCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["the deposit carries another intent", PAYLOAD, CREATOR],
    ["its creator isn't the sender's hub wallet", undefined, `0x${"9".repeat(40)}`],
  ])("isn't built without its quote when %s", async (_case, held, hubWallet) => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(held ?? (createIntentPayload(SUI_INTENT) as string)));
    vi.mocked(userHubWallet).mockResolvedValue(hubWallet);
    stubBackend({ row, hubIntent: SUI_INTENT });
    const { out } = await cancel({ txHash: SUI_TX, chain: "sui" });
    expect(out.error.code).toBe("SWAP_MISMATCH");
    expect(buildNonEvmCancel).not.toHaveBeenCalled();
  });

  it("refuses a Solana cancel the SDK built to another program than the packaged connection", async () => {
    vi.mocked(buildNonEvmCancel).mockResolvedValue({ from: "7".repeat(44), to: "Fake1111111111111111111111111111" });
    stubBackend({ row, hubIntent: SOLANA_INTENT });
    const { out } = await cancel({ txHash: SOLANA_TX, quoteId: claimed(solanaQuote(), SOLANA_TX) });
    expect(out.error.code).toBe("SWAP_MISMATCH");
  });

  it("says what to check when the SDK can't build the cancel", async () => {
    vi.mocked(buildNonEvmCancel).mockRejectedValue(new Error("SDK call failed"));
    stubBackend({ row, hubIntent: SUI_INTENT });
    const { out } = await cancel({ txHash: SUI_TX, quoteId: claimed(suiQuote(), SUI_TX) });
    expect(out.error).toMatchObject({
      code: "CHAIN_UNAVAILABLE",
      message: "Couldn't prepare the cancel on Sui right now.",
    });
  });

  it("is relayed once the cancel tx carries the intent's cancel payload", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(cancelPayload(SUI_INTENT) as string));
    const calls = stubBackend({ row, hubIntent: SUI_INTENT });
    const { out } = await cancel({ txHash: SUI_TX, quoteId: claimed(suiQuote(), SUI_TX), cancelTxHash: CANCEL_TX });
    expect(out.status).toBe("cancel_relayed");
    expect(readNonEvmTx).toHaveBeenCalledWith("sui", "SUI", CANCEL_TX, SUI_USER);
    expect(relays(calls)).toEqual([{ path: "/intents/submit", body: { chainId: "21", txHash: CANCEL_TX } }]);
  });

  it("is relayed from Solana with the cancel's relay data", async () => {
    const payload = cancelPayload(SOLANA_INTENT) as string;
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(payload, { chainKey: "solana" }));
    const calls = stubBackend({ row, hubIntent: SOLANA_INTENT });
    const signature = SOLANA_TX.replace(/D/g, "E");
    const { out } = await cancel({
      txHash: SOLANA_TX,
      quoteId: claimed(solanaQuote(), SOLANA_TX),
      cancelTxHash: signature,
    });
    expect(out.status).toBe("cancel_relayed");
    expect(relays(calls)).toEqual([
      { path: "/intents/submit", body: { chainId: "1", txHash: signature, data: { address: CREATOR, payload } } },
    ]);
  });

  it("isn't relayed when the cancel tx carries something else", async () => {
    vi.mocked(readNonEvmTx).mockResolvedValue(ranTx(PAYLOAD));
    const calls = stubBackend({ row, hubIntent: SUI_INTENT });
    const { out } = await cancel({ txHash: SUI_TX, quoteId: claimed(suiQuote(), SUI_TX), cancelTxHash: CANCEL_TX });
    expect(out.status).toBe("not_a_cancel_tx");
    expect(relays(calls)).toEqual([]);
  });
});
