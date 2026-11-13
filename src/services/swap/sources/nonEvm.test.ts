import { spokeChainConfig } from "@sodax/types";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { base58Bytes } from "../../../constants.js";
import { buildNonEvmCancel, buildNonEvmDeposit, initSodax } from "../../sodax.js";
import fixtures from "../__fixtures__/non-evm-txs.json" with { type: "json" };
import { toChain } from "../resolver.js";
import { EVM_SPOKE } from "./evm.js";
import { isAnyTxHash, pinnedSourceOf } from "./index.js";
import { INJECTIVE } from "./injective.js";
import { NEAR } from "./near.js";
import { jsonSafe, toNonEvmStep } from "./nonEvm.js";
import { SOLANA } from "./solana.js";
import { STELLAR } from "./stellar.js";
import { SUI } from "./sui.js";
import type { SwapSource, SwapToBuild } from "./types.js";

// The SDK's builds are scripted per test: what's checked is what the adapters do with them.
vi.mock("../../sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../sodax.js")>();
  return { ...actual, buildNonEvmDeposit: vi.fn(), buildNonEvmCancel: vi.fn() };
});

beforeAll(() => initSodax());

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(buildNonEvmDeposit).mockReset();
  vi.mocked(buildNonEvmCancel).mockReset();
});

const sourceOf = (chainKey: string): SwapSource => ({
  ...(pinnedSourceOf(chainKey) as NonNullable<ReturnType<typeof pinnedSourceOf>>),
  chain: toChain(chainKey),
});
/** The swap a quote checked, as far as a non-EVM build reads it; `to` is what the Swaps API's own build calls. */
const swapOf = (chainKey: keyof typeof fixtures, to?: string): SwapToBuild =>
  ({
    request: { srcChainKey: chainKey, srcAddress: "user", inputToken: "token", inputAmount: 1000n },
    built: { intent: fixtures[chainKey].intent, relayData: { address: "0xc", payload: "0x01" }, tx: { to } },
    approved: true,
    symbol: "TKN",
  }) as unknown as SwapToBuild;

describe("each source's tx hash", () => {
  const evm = `0x${"Ab".repeat(32)}`;
  it.each([
    [EVM_SPOKE, evm, evm.toLowerCase()],
    [EVM_SPOKE, "ab".repeat(32), undefined],
    [STELLAR, fixtures.stellar.txHash, fixtures.stellar.txHash],
    [STELLAR, `0x${fixtures.stellar.txHash.toUpperCase()}`, fixtures.stellar.txHash],
    [INJECTIVE, fixtures.injective.txHash.toLowerCase(), fixtures.injective.txHash],
    [INJECTIVE, `0x${fixtures.injective.txHash}`, fixtures.injective.txHash],
    [NEAR, fixtures.near.txHash, fixtures.near.txHash],
    [NEAR, fixtures.stellar.txHash, undefined],
    [SUI, fixtures.sui.txHash, fixtures.sui.txHash],
    [SOLANA, fixtures.solana.txHash, fixtures.solana.txHash],
    [SOLANA, fixtures.sui.txHash, undefined],
    // The right length in characters, but 88 and 44 bytes: a node answers those with an error.
    [SOLANA, "1".repeat(88), undefined],
    [NEAR, "1".repeat(44), undefined],
  ])("spells %# as its chain does", (adapter, value, expected) => {
    expect(adapter.txHash.spell(value)).toBe(expected);
  });

  it("lets every source's hash through the tool argument, and nothing with spaces or too short", () => {
    for (const { txHash } of Object.values(fixtures)) expect(isAnyTxHash(txHash)).toBe(true);
    expect(isAnyTxHash(`0x${"a".repeat(64)}`)).toBe(true);
    for (const value of ["0x1234", "abandon ability able", "a".repeat(63), "", " "]) {
      expect(isAnyTxHash(value)).toBe(false);
    }
  });
});

describe("a non-EVM build", () => {
  const { assetManager, connection } = spokeChainConfig.solana.addresses;
  // A tx's account keys are 32-byte program ids, as the deposit's message lists them.
  const passing = (...programs: string[]) =>
    Buffer.concat([Buffer.alloc(4), ...programs.map(program => Buffer.from(base58Bytes(program)))]).toString("base64");

  it("from Solana, whose programs the SDK reads from the chain, must call the packaged ones", async () => {
    vi.mocked(buildNonEvmDeposit).mockResolvedValue({ to: assetManager, data: passing(assetManager, connection) });
    await expect(SOLANA.prepareSwap(sourceOf("solana"), swapOf("solana"))).resolves.toMatchObject({
      steps: [{ kind: "swap", chainType: "SOLANA" }],
    });
    for (const built of [
      { to: assetManager, data: passing(assetManager) },
      { to: assetManager },
      { to: connection, data: passing(connection) },
    ]) {
      vi.mocked(buildNonEvmDeposit).mockResolvedValue(built);
      await expect(SOLANA.prepareSwap(sourceOf("solana"), swapOf("solana"))).rejects.toMatchObject({
        code: "SWAP_MISMATCH",
      });
    }
    vi.mocked(buildNonEvmCancel).mockResolvedValue({ to: connection });
    await expect(SOLANA.cancelStep(sourceOf("solana"), fixtures.solana.intent)).resolves.toMatchObject({
      kind: "cancel",
    });
    vi.mocked(buildNonEvmCancel).mockResolvedValue({ to: assetManager });
    await expect(SOLANA.cancelStep(sourceOf("solana"), fixtures.solana.intent)).rejects.toMatchObject({
      code: "SWAP_MISMATCH",
    });
  });

  it("from Sui, whose upgraded package the SDK reads from the chain, must call the Swaps API's own build's", async () => {
    const to = "0xe5f0::asset_manager::transfer";
    const user = `0x${"5".repeat(64)}`;
    vi.mocked(buildNonEvmDeposit).mockResolvedValue({ from: user, to, data: JSON.stringify({ version: 2 }) });
    const { steps } = await SUI.prepareSwap(sourceOf("sui"), swapOf("sui", to));
    // With its sender set, so no other account's wallet signs it.
    expect(JSON.parse((steps[0] as { tx: { data: string } }).tx.data)).toEqual({ version: 2, sender: user });
    for (const expected of ["0xbad::asset_manager::transfer", undefined]) {
      await expect(SUI.prepareSwap(sourceOf("sui"), swapOf("sui", expected))).rejects.toMatchObject({
        code: "SWAP_MISMATCH",
      });
    }
  });

  it("refuses an amount its allowance doesn't cover, as the family words it, before building anything", async () => {
    const unapproved = { ...swapOf("stellar"), approved: false };
    await expect(STELLAR.prepareSwap(sourceOf("stellar"), unapproved)).rejects.toMatchObject({
      code: "SWAP_REJECTED",
      message: expect.stringContaining("trustline"),
    });
    await expect(NEAR.prepareSwap(sourceOf("near"), { ...swapOf("near"), approved: false })).rejects.toMatchObject({
      code: "SWAP_REJECTED",
      message: expect.stringContaining("needs an approval"),
    });
    expect(buildNonEvmDeposit).not.toHaveBeenCalled();
  });

  it("is CHAIN_UNAVAILABLE when the SDK can't build it, with no SDK text", async () => {
    vi.mocked(buildNonEvmDeposit).mockRejectedValue(new Error("https://rpc.example/key fails"));
    const error = await NEAR.prepareSwap(sourceOf("near"), swapOf("near")).catch(e => e);
    expect(error).toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("rpc.example");
  });

  it("refuses a NEAR sender with an Ethereum-style account, which sends through a relayer track can't see", () => {
    expect(() => NEAR.checkSender?.(`0x${"a".repeat(40)}`)).toThrow(
      expect.objectContaining({ code: "INVALID_ADDRESS" }),
    );
    expect(() => NEAR.checkSender?.("alice.near")).not.toThrow();
  });
});

describe("Injective's read", () => {
  const source = () => sourceOf("injective-1");
  const HASH = fixtures.injective.txHash;
  const reply = (status: number, body: unknown) => Response.json(body, { status });
  const notFound = () => reply(404, { code: 5, message: `tx not found: ${HASH}` });
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const ran = { tx_response: { code: 0, events: [] } };

  it("reads the node's own NotFound, asked three times, as a tx it doesn't know", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => notFound());
    expect(await INJECTIVE.read(source(), HASH)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reads a tx in blocks the node has pruned as one it doesn't know, not as an outage", async () => {
    const pruned = { code: 2, message: "height 191258705 is not available, lowest height is 191260445", details: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply(500, pruned));
    expect(await INJECTIVE.read(source(), HASH)).toBeNull();
  });

  it("fails on any other 500, or a 404 from anything in front of the node, rather than read the tx as never sent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply(500, { code: 2, message: "internal error" }));
    await expect(INJECTIVE.read(source(), HASH)).rejects.toThrow();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(404, { message: "Not Found" }));
    await expect(INJECTIVE.read(source(), HASH)).rejects.toThrow();
  });

  it("asks a slow node's question again, or a node that dropped the tx, and reads it from the next node", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(timeout()).mockResolvedValueOnce(reply(200, ran));
    expect(await INJECTIVE.read(source(), HASH)).toEqual({ kind: "spoke", failed: false, messages: [] });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(notFound()).mockResolvedValueOnce(reply(200, ran));
    expect(await INJECTIVE.read(source(), HASH)).toEqual({ kind: "spoke", failed: false, messages: [] });
  });

  it("fails, rather than read the tx as unknown, when a node was too slow to answer", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeout())
      .mockImplementation(async () => notFound());
    await expect(INJECTIVE.read(source(), HASH)).rejects.toThrow();
  });
});

describe("toNonEvmStep", () => {
  it("keeps the SDK's raw tx, bigints as decimal strings and bytes as base64", () => {
    const raw = { from: "a", signedDoc: { bodyBytes: new Uint8Array([1, 2]), accountNumber: 7n }, list: [3n] };
    expect(toNonEvmStep("swap", "INJECTIVE", "injective-1", raw)).toEqual({
      kind: "swap",
      chainKey: "injective-1",
      chainType: "INJECTIVE",
      tx: { from: "a", signedDoc: { bodyBytes: "AQI=", accountNumber: "7" }, list: ["3"] },
    });
    expect(jsonSafe(Buffer.from([255]))).toBe("/w==");
  });

  it("refuses a raw tx that isn't an object", () => {
    expect(() => toNonEvmStep("swap", "SUI", "sui", "0x1234")).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });
});
