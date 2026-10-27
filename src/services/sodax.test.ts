import { readFileSync } from "node:fs";
import { EvmHubProvider, NearSpokeService, StellarSpokeService } from "@sodax/sdk";
import { solverConfig } from "@sodax/types";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";
import {
  approveCalldata,
  encodeRecipient,
  evmChainIdFor,
  initSodax,
  packagedToken,
  rebuildSwapTx,
  recipientReady,
  sdkLogger,
  swapContractFor,
  userHubWallet,
} from "./sodax.js";

const USER = "0x000000000000000000000000000000000000dEaD";

/** A live `POST /v1/swaps/intents` response (2026-10-26, nothing signed). */
function recorded(name: "built-intent-usdc-fee.json" | "built-intent-eth.json" | "built-intent-sonic.json") {
  return JSON.parse(readFileSync(new URL(`./swap/__fixtures__/${name}`, import.meta.url), "utf8"));
}

beforeAll(() => initSodax());

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("before initSodax", () => {
  it("refuses to use the SDK", async () => {
    vi.resetModules();
    const fresh = await import("./sodax.js");
    expect(() => fresh.approveCalldata(USER, USER, 1n)).toThrow("initSodax");
    expect(fresh.encodeRecipient("0xa4b1.arbitrum", USER)).toBeUndefined();
  });
});

describe("rebuildSwapTx", () => {
  it.each([
    ["built-intent-usdc-fee.json", "0xa4b1.arbitrum", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 5000000n],
    ["built-intent-eth.json", "0xa4b1.arbitrum", "0x0000000000000000000000000000000000000000", 2000000000000000n],
    ["built-intent-sonic.json", "sonic", "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", 5000000n],
  ] as const)("rebuilds a live swap tx (%s) byte for byte", async (name, srcChainKey, token, amount) => {
    const { tx, intent, relayData } = recorded(name);
    const rebuilt = await rebuildSwapTx({ srcChainKey, srcAddress: USER, token, amount, intent });
    expect(rebuilt?.to.toLowerCase()).toBe(tx.to.toLowerCase());
    expect(rebuilt?.value).toBe(BigInt(tx.value));
    expect(rebuilt?.data.toLowerCase()).toBe(tx.data.toLowerCase());
    expect(rebuilt?.payload.toLowerCase()).toBe(relayData.payload.toLowerCase());
  });

  it("scales a native HBAR deposit the way Hedera expects", async () => {
    const { intent } = recorded("built-intent-eth.json");
    const hbar = "0x0000000000000000000000000000000000000000";
    const rebuilt = await rebuildSwapTx({ srcChainKey: "hedera", srcAddress: USER, token: hbar, amount: 5n, intent });
    expect(rebuilt?.value).toBe(50000000000n);
  });

  it("gives up quietly on an intent the SDK can't encode", async () => {
    const { intent } = recorded("built-intent-eth.json");
    const broken = { ...intent, intentId: "not a number" };
    expect(
      await rebuildSwapTx({
        srcChainKey: "0xa4b1.arbitrum",
        srcAddress: USER,
        token: USER,
        amount: 1n,
        intent: broken,
      }),
    ).toBeUndefined();
  });
});

describe("addresses and contracts", () => {
  it("encodes recipients the SDK's way, refusing what isn't valid for the chain", () => {
    expect(encodeRecipient("0xa4b1.arbitrum", USER)).toBe(USER);
    expect(encodeRecipient("0xa4b1.arbitrum", "0x000000000000000000000000000000000000DEad")).toBeUndefined();
    expect(encodeRecipient("sui", "0x2")).toBe(`0x${"0".repeat(63)}2`);
    expect(encodeRecipient("near", "alice.near")).toBe("0x616c6963652e6e656172");
    expect(encodeRecipient("nowhere", USER)).toBeUndefined();
  });

  it("pins the swap contract: a spoke's asset manager, the hub intents contract", () => {
    expect(swapContractFor("0xa4b1.arbitrum")).toBe("0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3");
    expect(swapContractFor("sonic")).toBe(solverConfig.intentsContract);
    expect(swapContractFor("solana")).toBeUndefined();
    expect(swapContractFor("nowhere")).toBeUndefined();
  });

  it("reads chain ids and tokens from the packaged config", () => {
    expect(evmChainIdFor("0xa4b1.arbitrum")).toBe(42161);
    expect(evmChainIdFor("sonic")).toBe(146);
    expect(evmChainIdFor("sui")).toBeUndefined();
    expect(evmChainIdFor("constructor")).toBeUndefined();
    expect(packagedToken("0xa4b1.arbitrum", "0xAF88d065e77c8cc2239327c5edb3a432268e5831")).toMatchObject({
      decimals: 6,
      hubAsset: "0xdB7BdA65c3a1C51D64dC4444e418684677334109",
    });
    expect(packagedToken("sonic", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toBeUndefined();
  });

  it("encodes an approve as the SDK does", () => {
    const data = approveCalldata("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", solverConfig.intentsContract, 5n);
    expect(data).toBe(
      `0x095ea7b3${solverConfig.intentsContract.slice(2).toLowerCase().padStart(64, "0")}${"5".padStart(64, "0")}`,
    );
  });
});

describe("SDK calls", () => {
  it("never pass the SDK's error on: its text can carry RPC URLs and addresses", async () => {
    vi.spyOn(EvmHubProvider.prototype, "getUserHubWalletAddress").mockRejectedValue(
      new Error("URL: https://rpc/key123"),
    );
    vi.spyOn(NearSpokeService.prototype, "isStorageRegistered").mockRejectedValue(new Error("body: alice.near"));
    await expect(userHubWallet("0xa4b1.arbitrum", USER)).rejects.toThrow(/^SDK call failed$/);
    await expect(recipientReady("NEAR", "usdc.near", "alice.near", 1n)).rejects.toThrow(/^SDK call failed$/);
  });

  it("ask the right chain: NEAR storage, or the Stellar trustline for the amount", async () => {
    const storage = vi.spyOn(NearSpokeService.prototype, "isStorageRegistered").mockResolvedValue(true);
    const trustline = vi.spyOn(StellarSpokeService.prototype, "hasSufficientTrustline").mockResolvedValue(false);
    await expect(recipientReady("NEAR", "usdc.near", "alice.near", 5n)).resolves.toBe(true);
    expect(storage).toHaveBeenCalledWith("usdc.near", "alice.near");
    await expect(recipientReady("STELLAR", "USDC-SAC", "GABC", 5n)).resolves.toBe(false);
    expect(trustline).toHaveBeenCalledWith("USDC-SAC", 5n, "GABC");
  });

  it("give up after 15 seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(EvmHubProvider.prototype, "getUserHubWalletAddress").mockReturnValue(new Promise(() => {}));
    const pending = expect(userHubWallet("0xa4b1.arbitrum", USER)).rejects.toThrow("SDK call failed");
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
  });

  it("pass a result through", async () => {
    vi.spyOn(EvmHubProvider.prototype, "getUserHubWalletAddress").mockResolvedValue(`0x${"c".repeat(40)}`);
    await expect(userHubWallet("0xa4b1.arbitrum", USER)).resolves.toBe(`0x${"c".repeat(40)}`);
  });
});

describe("sdkLogger", () => {
  it("passes on only the SDK's message, never its error or data", () => {
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    sdkLogger.debug();
    sdkLogger.info();
    sdkLogger.warn("balance read failed");
    sdkLogger.error("rpc failed");
    expect(warn).toHaveBeenCalledWith({ source: "sodax-sdk" }, "balance read failed");
    expect(error).toHaveBeenCalledWith({ source: "sodax-sdk" }, "rpc failed");
  });
});
