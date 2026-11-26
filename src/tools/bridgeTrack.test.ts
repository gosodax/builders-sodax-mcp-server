import { EvmHubProvider } from "@sodax/sdk";
import { hubConfig } from "@sodax/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBridge } from "../services/bridge/store.js";
import { logger } from "../services/logger.js";
import {
  type EvmReceipt,
  bridgeLimit,
  getEvmReceipt,
  getHubTx,
  initSodax,
  intentChainId,
  isTxKnown,
  relayPackets,
} from "../services/sodax.js";
import { messageReceipt } from "../services/swap/__fixtures__/deposit.js";
import { rlpList } from "../services/swap/__fixtures__/encode.js";
import { HOOK_FAILED_TOPIC, TRANSFER_TOPIC } from "../services/swap/sourceTx.js";
import { bridgeClient } from "./__fixtures__/swapClient.js";

// The chain reads are scripted; the builds and checks run on the real SDK.
vi.mock("../services/sodax.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../services/sodax.js")>()),
  bridgeLimit: vi.fn(),
  getEvmReceipt: vi.fn(),
  getHubTx: vi.fn(),
  isTxKnown: vi.fn(),
  relayPackets: vi.fn(),
}));

const actual = await vi.importActual<typeof import("../services/sodax.js")>("../services/sodax.js");
await initSodax();

const USER = "0x67efb0c797e5586e6d5ff80714c1dd64ba84be0b";
const HUB_WALLET = `0x${"c".repeat(40)}`;
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TX = `0x${"ab".repeat(32)}`;
const HUB_TX = `0x${"cd".repeat(32)}`;
const TO_BASE = { fromChain: "arbitrum", fromToken: "USDC", toChain: "base", toToken: "USDC", amount: "5" };
const TO_SONIC = { ...TO_BASE, toChain: "sonic" };

/** An address as a log's topic or data word. */
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const hubReceipt = (logs: EvmReceipt["logs"], reverted = false): EvmReceipt => ({
  reverted,
  blockNumber: 2n,
  txIndex: 0,
  logs,
});
type Kept = { request: { dstChainKey: string; dstToken: string }; delivered: bigint };
/** The hub wallet's last call on a bridge to Sonic: the token to the recipient, the amount they get. */
const deliveryLog = (kept: Kept, to = USER) => ({
  address: actual.bridgeHubAsset({ chainKey: kept.request.dstChainKey, address: kept.request.dstToken }),
  topics: [TRANSFER_TOPIC, word(HUB_WALLET), word(to)],
  data: `0x${kept.delivered.toString(16).padStart(64, "0")}`,
});
/** As the hub logs it: the wallet, then the reason string (offset, length, here empty). */
const hookFailedLog = (wallet = HUB_WALLET, address: string = hubConfig.addresses.assetManager) => ({
  address,
  topics: [HOOK_FAILED_TOPIC],
  data: `${word(wallet)}${"40".padStart(64, "0")}${"0".repeat(64)}`,
});

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;
/** The backend's row for TX, or none; the submits it took, and how it answers one. */
let row: Record<string, unknown> | undefined;
let submits: Record<string, unknown>[];
let submitAnswer: () => Response;

beforeEach(() => {
  vi.spyOn(EvmHubProvider.prototype, "getUserHubWalletAddress").mockResolvedValue(HUB_WALLET);
  vi.mocked(bridgeLimit).mockResolvedValue({ amount: 10n ** 12n, decimals: 6, type: "DEPOSIT_LIMIT" });
  vi.mocked(isTxKnown).mockResolvedValue(false);
  vi.mocked(relayPackets).mockResolvedValue([]);
  row = undefined;
  submits = [];
  submitAnswer = () => Response.json({ success: true, data: { status: "inserted", message: "ok" } });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.endsWith("/allowance/check")) return Response.json({ valid: true });
    if (url.endsWith("/intents")) {
      const { tx, relayData } = await actual.sdkBridge({
        srcChainKey: body.srcChainKey,
        srcAddress: body.srcAddress,
        srcToken: body.inputToken,
        amount: BigInt(body.inputAmount),
        dstChainKey: body.dstChainKey,
        dstToken: body.outputToken,
        recipient: body.dstAddress,
      });
      const { value, ...rest } = tx as { value: bigint };
      return Response.json({ tx: { ...rest, value: value.toString() }, relayData });
    }
    if (url.includes("/submit-tx/status")) {
      return row ? Response.json({ success: true, data: row }) : Response.json({ message: "none" }, { status: 404 });
    }
    if (url.endsWith("/submit-tx")) {
      submits.push(body);
      return submitAnswer();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(name: string, args: Record<string, unknown>) {
  const client = await bridgeClient();
  await client.listTools();
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result.structuredContent as Record<string, unknown> & {
    status: string;
    nextStep: string;
    terminal: boolean;
    outcome?: string;
    nextAction: Record<string, unknown>;
    error?: { code: string };
  };
}

/** A prepared bridge, and the receipt its deposit would have on Arbitrum. */
async function prepared(args = TO_BASE) {
  const out = await call("sodax_bridge_prepare", { ...args, fromAddress: USER });
  const bridgeId = out.bridgeId as string;
  const kept = getBridge(bridgeId);
  if (!kept) throw new Error("not kept");
  const transfer = (to: string) => rlpList([ARB_USDC.toLowerCase(), USER, to, "0x4c4b40", kept.relayData.payload]);
  return { bridgeId, kept, deposit: messageReceipt({ payload: transfer(HUB_WALLET) }), transfer };
}

describe("sodax_bridge_submit_and_track", () => {
  it("submits a deposit checked against its build once, then reports it on its way", async () => {
    const { bridgeId, kept, deposit } = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out).toMatchObject({ status: "relaying", terminal: false });
    expect(out.nextAction).toMatchObject({ type: "call_tool", tool: "sodax_bridge_submit_and_track", sameArgs: true });
    expect(submits).toEqual([
      { txHash: TX, srcChainKey: "0xa4b1.arbitrum", walletAddress: USER, relayData: kept.relayData },
    ]);
    expect(getBridge(bridgeId)?.depositTxHash).toBe(TX);
    // Again: the backend's row now answers, and nothing is resubmitted.
    row = { status: "relaying" };
    await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(submits).toHaveLength(1);
  });

  it("refuses a tx that deposits to another hub wallet, asking for the right hash", async () => {
    const { bridgeId, transfer } = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValue(messageReceipt({ payload: transfer(`0x${"d".repeat(40)}`) }));
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out).toMatchObject({ status: "not_submitted", reason: "not_this_bridge" });
    expect(out.nextAction).toMatchObject({ type: "provide", fields: [{ name: "txHash" }] });
    expect(submits).toEqual([]);
  });

  it("never takes a backend row as proof that a tx is this bridge's deposit", async () => {
    const { bridgeId, transfer } = await prepared();
    // Someone's bridge, submitted already: the row says executed, but the tx deposits to another hub wallet.
    row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
    vi.mocked(getEvmReceipt).mockResolvedValue(messageReceipt({ payload: transfer(`0x${"d".repeat(40)}`) }));
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out).toMatchObject({ status: "not_submitted", reason: "not_this_bridge" });
    expect(getBridge(bridgeId)?.depositTxHash).toBeUndefined();
  });

  it("from Sonic, takes as its deposit only the tx the build made, its value included", async () => {
    const out = await call("sodax_bridge_prepare", { ...TO_BASE, fromChain: "sonic", fromAddress: USER });
    const kept = getBridge(out.bridgeId as string);
    if (!kept?.deposit) throw new Error("no Sonic deposit kept");
    const { to, data, value } = kept.deposit;
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt([]));
    vi.mocked(getHubTx).mockResolvedValue({ from: USER, to, input: data, value: BigInt(value) + 1n });
    const track = () => call("sodax_bridge_submit_and_track", { bridgeId: kept.bridgeId, txHash: TX });
    expect(await track()).toMatchObject({ status: "not_submitted", reason: "not_this_bridge" });
    vi.mocked(getHubTx).mockResolvedValue({ from: USER, to, input: data, value: BigInt(value) });
    expect(await track()).toMatchObject({ status: "relaying" });
  });

  it("from Sonic, waits for a mined tx whose node serves the receipt before the tx", async () => {
    const out = await call("sodax_bridge_prepare", { ...TO_BASE, fromChain: "sonic", fromAddress: USER });
    const kept = getBridge(out.bridgeId as string);
    if (!kept?.deposit) throw new Error("no Sonic deposit kept");
    const { to, data, value } = kept.deposit;
    vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt([]));
    vi.mocked(getHubTx).mockResolvedValue(null);
    const track = () => call("sodax_bridge_submit_and_track", { bridgeId: kept.bridgeId, txHash: TX });
    expect(await track()).toMatchObject({ status: "awaiting_source", seenOnChain: true, terminal: false });
    expect(submits).toEqual([]);
    vi.mocked(getHubTx).mockResolvedValue({ from: USER, to, input: data, value: BigInt(value) });
    expect(await track()).toMatchObject({ status: "relaying" });
  });

  it("alerts on a checked deposit submit-tx refuses, and hands it to a person; retries one that may pass", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    submitAnswer = () => Response.json({ message: "walletAddress must be shorter" }, { status: 400 });
    const { bridgeId, deposit } = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out).toMatchObject({ status: "not_submitted", reason: "submit_refused", terminal: true });
    expect(out.nextAction).toMatchObject({ type: "external", reason: "help_desk" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "bridge_submit_rejected", "tx.hash": TX }),
      expect.any(String),
    );
    submitAnswer = () => new Response("down", { status: 503 });
    const retried = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(retried.error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(submits).toHaveLength(2);
  });

  it("past the claim, retries a key refusal: a new key couldn't track the bridge", async () => {
    submitAnswer = () => Response.json({ message: "Invalid API key" }, { status: 401 });
    const { bridgeId, deposit } = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out.error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSec: 60 });
    expect(out.nextStep).not.toContain("API key");
    expect(getBridge(bridgeId)?.depositTxHash).toBe(TX);
    // Without a build nothing is bound to the key, so a refusal stays the key's to fix.
    fetchSpy.mockImplementationOnce(async () => Response.json({ message: "Invalid API key" }, { status: 401 }));
    const unbound = await call("sodax_bridge_submit_and_track", { chain: "arbitrum", txHash: TX });
    expect(unbound.error?.code).toBe("API_KEY_REQUIRED");
  });

  it("waits for a tx not mined yet, and ends a failed one", async () => {
    const { bridgeId } = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValueOnce(null);
    expect(await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX })).toMatchObject({
      status: "awaiting_source",
      terminal: false,
    });
    // With the build, the backend's row waits for the deposit check: no Bridge API call while the tx isn't mined.
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("/submit-tx"))).toEqual([]);
    vi.mocked(getEvmReceipt).mockResolvedValueOnce({ reverted: true, blockNumber: 1n, txIndex: 0, logs: [] });
    expect(await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX })).toMatchObject({
      status: "source_failed",
      terminal: true,
      outcome: "failed",
    });
  });

  it("follows a bridge to a spoke past the hub, and ends one to Sonic there", async () => {
    const toBase = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValue(toBase.deposit);
    await call("sodax_bridge_submit_and_track", { bridgeId: toBase.bridgeId, txHash: TX });
    row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
    expect(await call("sodax_bridge_submit_and_track", { bridgeId: toBase.bridgeId, txHash: TX })).toMatchObject({
      status: "in_transit",
      hubTxHash: HUB_TX,
      terminal: false,
    });
    const toSonic = await prepared(TO_SONIC);
    row = undefined;
    vi.mocked(getEvmReceipt).mockResolvedValue(toSonic.deposit);
    await call("sodax_bridge_submit_and_track", { bridgeId: toSonic.bridgeId, txHash: TX });
    row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
    vi.mocked(getEvmReceipt).mockImplementation(async (_, txHash) =>
      txHash === HUB_TX ? hubReceipt([deliveryLog(toSonic.kept)]) : toSonic.deposit,
    );
    expect(await call("sodax_bridge_submit_and_track", { bridgeId: toSonic.bridgeId, txHash: TX })).toMatchObject({
      status: "delivered",
      dstTxHash: HUB_TX,
      terminal: true,
      outcome: "succeeded",
    });
  });

  describe("past the hub, to a spoke", () => {
    const DST_TX = `0x${"ef".repeat(32)}`;
    const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const HUB_ASSET_MANAGER = "60c5681bd1db4e50735c4ca3386005a4ba4937c0";
    /**
     * The hub's packet to Base, as the relay reports it: addresses and payload in hex without 0x, relay chain ids, and
     * tx hashes in their chain's format.
     */
    const packet = (
      over: {
        to?: string;
        amount?: string;
        status?: string;
        from?: string;
        by?: string;
        tx?: string;
        dst?: string;
        dstTx?: string;
      } = {},
    ) => ({
      src_chain_id: 146,
      src_tx_hash: over.tx ?? HUB_TX,
      src_address: over.by ?? HUB_ASSET_MANAGER,
      status: over.status ?? "executed",
      dst_chain_id: Number(intentChainId(over.dst ?? "0x2105.base")),
      dst_tx_hash: over.dstTx ?? DST_TX,
      payload: rlpList([BASE_USDC, over.from ?? HUB_WALLET, over.to ?? USER, over.amount ?? "0x4c4b40", "0x"]).slice(2),
    });

    async function atTheHub() {
      const { bridgeId, deposit } = await prepared();
      vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
      await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
      row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
      return () => call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    }

    it("is delivered once the hub's packet to the recipient ran there", async () => {
      const track = await atTheHub();
      vi.mocked(relayPackets).mockResolvedValue([packet()]);
      expect(await track()).toMatchObject({
        status: "delivered",
        dstTxHash: DST_TX,
        delivery: "delivered",
        terminal: true,
        outcome: "succeeded",
      });
      expect(relayPackets).toHaveBeenCalledWith("sonic", HUB_TX);
    });

    it.each([
      ["while the packet hasn't run", () => [packet({ status: "pending" })]],
      ["for a packet to another recipient", () => [packet({ to: `0x${"9".repeat(40)}` })]],
      ["for a packet of another amount", () => [packet({ amount: "0x4c4b41" })]],
      ["for a packet from another hub wallet", () => [packet({ from: `0x${"d".repeat(40)}` })]],
      ["for a packet another contract sent", () => [packet({ by: "d".repeat(40) })]],
      ["when two packets match, as it can't tell which", () => [packet(), packet()]],
      ["when the relay has none yet", () => []],
    ])("stays in transit %s", async (_, packets) => {
      const track = await atTheHub();
      vi.mocked(relayPackets).mockResolvedValue(packets());
      expect(await track()).toMatchObject({ status: "in_transit", hubTxHash: HUB_TX, terminal: false });
    });

    it("stays in transit when the relay can't be read", async () => {
      const track = await atTheHub();
      vi.mocked(relayPackets).mockRejectedValue(new Error("SDK call failed"));
      expect(await track()).toMatchObject({ status: "in_transit" });
    });

    it("waits while the hub tx the row names reverted", async () => {
      const track = await atTheHub();
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt([], true));
      vi.mocked(relayPackets).mockResolvedValue([packet()]);
      expect(await track()).toMatchObject({ status: "relaying", terminal: false });
    });

    it("from Sonic, follows the user's own tx's packet, never the row's word", async () => {
      const out = await call("sodax_bridge_prepare", { ...TO_BASE, fromChain: "sonic", fromAddress: USER });
      const kept = getBridge(out.bridgeId as string);
      if (!kept?.deposit) throw new Error("no Sonic deposit kept");
      const { to, data, value } = kept.deposit;
      vi.mocked(getHubTx).mockResolvedValue({ from: USER, to, input: data, value: BigInt(value) });
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt([]));
      const track = () => call("sodax_bridge_submit_and_track", { bridgeId: kept.bridgeId, txHash: TX });
      expect(await track()).toMatchObject({ status: "relaying" });
      row = { status: "executed", result: { dstIntentTxHash: DST_TX } };
      expect(await track()).toMatchObject({ status: "in_transit", hubTxHash: TX });
      vi.mocked(relayPackets).mockResolvedValue([packet({ tx: TX })]);
      expect(await track()).toMatchObject({ status: "delivered", dstTxHash: DST_TX, delivery: "delivered" });
      expect(relayPackets).toHaveBeenCalledWith("sonic", TX);
    });

    it.each([
      [
        "a Solana signature",
        "solana",
        "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
      ],
      ["a Bitcoin txid", "bitcoin", "ab".repeat(32)],
    ])("passes on the destination's hash as its chain writes it: %s", async (_, dst, dstTx) => {
      row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt([]));
      vi.mocked(relayPackets).mockResolvedValue([packet({ dst, dstTx })]);
      const out = await call("sodax_bridge_submit_and_track", { chain: "arbitrum", txHash: TX });
      expect(out).toMatchObject({ status: "delivered", dstTxHash: dstTx });
      expect(out.nextStep).toContain(`destination tx ${dstTx})`);
    });

    it("from Sonic, holds a bridge the backend gave up on until the relay delivers it", async () => {
      const out = await call("sodax_bridge_prepare", { ...TO_BASE, fromChain: "sonic", fromAddress: USER });
      const kept = getBridge(out.bridgeId as string);
      if (!kept?.deposit) throw new Error("no Sonic deposit kept");
      const { to, data, value } = kept.deposit;
      vi.mocked(getHubTx).mockResolvedValue({ from: USER, to, input: data, value: BigInt(value) });
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt([]));
      const track = () => call("sodax_bridge_submit_and_track", { bridgeId: kept.bridgeId, txHash: TX });
      await track();
      row = { status: "failed", abandonedAt: "2026-11-26T00:00:00Z" };
      const held = await track();
      expect(held).toMatchObject({ status: "relay_failed", terminal: true, outcome: "held" });
      expect(held.nextStep).toContain("The bridge left Sonic, but the relay gave up before the destination chain");
      vi.mocked(relayPackets).mockResolvedValue([packet({ tx: TX })]);
      expect(await track()).toMatchObject({ status: "delivered", dstTxHash: DST_TX });
    });

    it("without the build, calls a packet to Bitcoin sent, not delivered", async () => {
      row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
      vi.mocked(getEvmReceipt).mockResolvedValue(hubReceipt([]));
      vi.mocked(relayPackets).mockResolvedValue([packet({ dst: "bitcoin" })]);
      expect(await call("sodax_bridge_submit_and_track", { chain: "arbitrum", txHash: TX })).toMatchObject({
        status: "delivered",
        delivery: "sent",
      });
    });
  });

  describe("past the hub, to Sonic", () => {
    async function atTheHub() {
      const { bridgeId, kept, deposit } = await prepared(TO_SONIC);
      vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
      await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
      row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
      const hubLogs = (logs: EvmReceipt["logs"]) =>
        vi
          .mocked(getEvmReceipt)
          .mockImplementation(async (_, txHash) => (txHash === HUB_TX ? hubReceipt(logs) : deposit));
      return { kept, hubLogs, track: () => call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX }) };
    }

    it("is delivered once the hub tx shows the token sent to the recipient", async () => {
      const { kept, hubLogs, track } = await atTheHub();
      hubLogs([deliveryLog(kept)]);
      expect(await track()).toMatchObject({ status: "delivered", dstTxHash: HUB_TX, outcome: "succeeded" });
    });

    it.each([
      ["shows no delivery", () => []],
      ["sends the token to another address", (kept: Kept) => [deliveryLog(kept, `0x${"9".repeat(40)}`)]],
      ["sends another amount", (kept: Kept) => [deliveryLog({ ...kept, delivered: kept.delivered + 1n })]],
    ])("stays in transit while the hub tx %s", async (_, logs) => {
      const { kept, hubLogs, track } = await atTheHub();
      hubLogs(logs(kept));
      expect(await track()).toMatchObject({ status: "in_transit", hubTxHash: HUB_TX, terminal: false });
    });

    it("takes a HookFailed only for this bridge's hub wallet, from the hub asset manager", async () => {
      const { kept, hubLogs, track } = await atTheHub();
      const otherWallet = hookFailedLog(`0x${"9".repeat(40)}`);
      const otherContract = hookFailedLog(HUB_WALLET, `0x${"9".repeat(40)}`);
      hubLogs([otherWallet, otherContract, deliveryLog(kept)]);
      expect(await track()).toMatchObject({ status: "delivered" });
    });
  });

  it("says the tokens are held in the hub wallet when its calls failed there, never delivered", async () => {
    const { bridgeId, kept, deposit } = await prepared(TO_SONIC);
    vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
    await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    row = { status: "executed", result: { dstIntentTxHash: HUB_TX } };
    vi.mocked(getEvmReceipt).mockImplementation(async (_, txHash) =>
      txHash === HUB_TX ? hubReceipt([hookFailedLog(), deliveryLog(kept)]) : deposit,
    );
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out).toMatchObject({
      status: "held_on_hub",
      recovery: { srcChainKey: "0xa4b1.arbitrum", srcAddress: USER, token: ARB_USDC },
      terminal: true,
      outcome: "held",
    });
    expect(out.nextStep).toContain("withdrawHubAsset");
  });

  it.each([
    ["abandoned", { status: "failed", abandonedAt: "2026-11-26T00:00:00Z" }],
    ["failed", { status: "failed", failedAtStep: "relaying" }],
  ])("hands a bridge the relay %s to the operator", async (_, given) => {
    const { bridgeId, deposit } = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
    await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    row = given;
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out).toMatchObject({ status: "relay_failed", terminal: true, outcome: "held" });
    expect(out.nextAction).toMatchObject({ type: "external", reason: "help_desk" });
  });

  it("follows a bridge the backend gave up on that the relay delivered to the hub anyway, as the SDK does", async () => {
    const { bridgeId, deposit } = await prepared();
    vi.mocked(getEvmReceipt).mockResolvedValue(deposit);
    await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    row = { status: "failed", abandonedAt: "2026-11-26T00:00:00Z" };
    /** The deposit's packet, as the relay reports it for the source tx. */
    const toHub = (over: { status?: string; dst?: string } = {}) => ({
      src_chain_id: Number(intentChainId("0xa4b1.arbitrum")),
      src_tx_hash: TX,
      src_address: "ab".repeat(20),
      status: over.status ?? "executed",
      dst_chain_id: Number(intentChainId(over.dst ?? "sonic")),
      dst_tx_hash: HUB_TX,
      payload: "c0",
    });
    const relayHas = (packets: ReturnType<typeof toHub>[]) =>
      vi.mocked(relayPackets).mockImplementation(async chainKey => (chainKey === "0xa4b1.arbitrum" ? packets : []));
    const track = () => call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    for (const packets of [[], [toHub({ status: "pending" })], [toHub({ dst: "0x2105.base" })], [toHub(), toHub()]]) {
      relayHas(packets);
      expect(await track()).toMatchObject({ status: "relay_failed", terminal: true });
    }
    relayHas([toHub()]);
    expect(await track()).toMatchObject({ status: "in_transit", hubTxHash: HUB_TX, terminal: false });
    expect(relayPackets).toHaveBeenCalledWith("0xa4b1.arbitrum", TX);
  });

  it("follows a bridge the backend has without its build, and leaves one it hasn't to the operator", async () => {
    row = { status: "relaying" };
    expect(await call("sodax_bridge_submit_and_track", { chain: "arbitrum", txHash: TX })).toMatchObject({
      status: "relaying",
    });
    row = undefined;
    vi.mocked(getEvmReceipt).mockResolvedValue(
      messageReceipt({ payload: rlpList([ARB_USDC, USER, HUB_WALLET, "0x01", "0x"]) }),
    );
    const out = await call("sodax_bridge_submit_and_track", { chain: "arbitrum", txHash: TX });
    expect(out).toMatchObject({ status: "not_submitted", reason: "unknown_bridge", terminal: true });
    expect(submits).toEqual([]);
  });

  it("only lets the key that prepared a bridge track it", async () => {
    const { bridgeId, kept } = await prepared();
    kept.keyHash = "another key";
    const out = await call("sodax_bridge_submit_and_track", { bridgeId, txHash: TX });
    expect(out.error?.code).toBe("QUOTE_KEY_MISMATCH");
  });
});
