import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EvmHubProvider, NearSpokeService, SpokeService, StellarSpokeService } from "@sodax/sdk";
import { solverConfig } from "@sodax/types";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";
import {
  approveCalldata,
  cancelPayload,
  checksumValid,
  connectionFor,
  encodeRecipient,
  evmChainIdFor,
  initSodax,
  intentChainId,
  packagedToken,
  parseRpcOverrides,
  rebuildSwapTx,
  recipientReady,
  sdkLogger,
  swapContractFor,
  userHubWallet,
  walletBalance,
} from "./sodax.js";

const USER = "0x000000000000000000000000000000000000dEaD";

// Not a dependency here: the copy the SDK runs on, so its errors are the ones the SDK sees.
const stellar = createRequire(createRequire(import.meta.url).resolve("@sodax/sdk"))("@stellar/stellar-sdk");

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

describe("cancelPayload", () => {
  it("is one cancelIntent call on the pinned intents contract, for exactly this intent", () => {
    const { intent } = recorded("built-intent-eth.json");
    const payload = cancelPayload(intent) ?? "";
    expect(payload).toContain(solverConfig.intentsContract.slice(2).toLowerCase());
    expect(payload).toContain(BigInt(intent.intentId).toString(16));
    expect(cancelPayload(intent)).toBe(payload);
    expect(cancelPayload({ ...intent, minOutputAmount: "2" })).not.toBe(payload);
  });

  it("gives up quietly on an intent the SDK can't encode", () => {
    const { intent } = recorded("built-intent-eth.json");
    expect(cancelPayload({ ...intent, srcChain: "999" })).toBeUndefined();
    expect(cancelPayload({ ...intent, intentId: "not a number" })).toBeUndefined();
  });
});

describe("addresses and contracts", () => {
  it("encodes recipients the SDK's way, refusing what isn't valid for the chain", () => {
    expect(encodeRecipient("0xa4b1.arbitrum", USER)).toBe(USER);
    expect(encodeRecipient("0xa4b1.arbitrum", "0x000000000000000000000000000000000000DEad")).toBeUndefined();
    expect(encodeRecipient("sui", `0x${"0".repeat(63)}2`)).toBe(`0x${"0".repeat(63)}2`);
    // The SDK would pad these to 32 bytes.
    expect(encodeRecipient("sui", "0x2")).toBeUndefined();
    expect(encodeRecipient("sui", USER)).toBeUndefined();
    expect(encodeRecipient("near", "alice.near")).toBe("0x616c6963652e6e656172");
    expect(encodeRecipient("nowhere", USER)).toBeUndefined();
  });

  it("takes only a mainnet Stacks principal, which the SDK can't tell from a testnet one", () => {
    expect(encodeRecipient("stacks", "SP3031RGK734636C8KGW2Y76TEQBTVX59Q472EQH0")).toMatch(/^0x0516/);
    expect(encodeRecipient("stacks", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4")).toMatch(/^0x0514/);
    expect(encodeRecipient("stacks", "SP000000000000000000002Q6VF78.pox-4")).toMatch(/^0x0616/);
    // Testnet with the version letter in either case (the SDK reads both), and any other version.
    for (const notMainnet of [
      "ST000000000000000000002AMW42H",
      "St000000000000000000002AMW42H",
      "SN000000000000000000003YDHWKJ",
      "Sn000000000000000000003YDHWKJ",
      "St000000000000000000002AMW42H.pox-4",
      "SA3031RG000000000000000000000000002XQ4A5D",
    ]) {
      expect(encodeRecipient("stacks", notMainnet)).toBeUndefined();
    }
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
    expect(intentChainId("0xa4b1.arbitrum")).toBe("23");
    expect(intentChainId("sonic")).toBe("146");
    expect(intentChainId("constructor")).toBeUndefined();
    expect(packagedToken("0xa4b1.arbitrum", "0xAF88d065e77c8cc2239327c5edb3a432268e5831")).toMatchObject({
      decimals: 6,
      hubAsset: "0xdB7BdA65c3a1C51D64dC4444e418684677334109",
    });
    expect(packagedToken("sonic", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toBeUndefined();
  });

  it("checks a mixed-case address's EIP-55 checksum", () => {
    expect(checksumValid(USER)).toBe(true);
    expect(checksumValid("0x000000000000000000000000000000000000DEad")).toBe(false);
    expect(checksumValid(USER.toLowerCase())).toBe(true);
    expect(checksumValid(`0x${USER.slice(2).toUpperCase()}`)).toBe(true);
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

describe("walletBalance", () => {
  const USDC = { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" };

  it("reads the token for the address on the chain, and passes the base units through", async () => {
    const read = vi.spyOn(SpokeService.prototype, "getWalletBalance").mockResolvedValue({ ok: true, value: 5n });
    await expect(walletBalance("0xa4b1.arbitrum", USER, USDC)).resolves.toBe(5n);
    expect(read).toHaveBeenCalledWith({ srcChainKey: "0xa4b1.arbitrum", srcAddress: USER, token: USDC });
  });

  it("fails a read the SDK reports as failed, or that throws, without its text: never 0", async () => {
    vi.spyOn(SpokeService.prototype, "getWalletBalance").mockResolvedValueOnce({
      ok: false,
      error: new Error("URL: https://rpc/key123"),
    } as never);
    await expect(walletBalance("0xa4b1.arbitrum", USER, USDC)).rejects.toThrow(/^SDK call failed$/);
    vi.spyOn(SpokeService.prototype, "getWalletBalance").mockRejectedValueOnce(new Error("URL: https://rpc/key123"));
    await expect(walletBalance("0xa4b1.arbitrum", USER, USDC)).rejects.toThrow(/^SDK call failed$/);
  });

  it("gives up after 8 seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(SpokeService.prototype, "getWalletBalance").mockReturnValue(new Promise(() => {}));
    const pending = expect(walletBalance("0xa4b1.arbitrum", USER, USDC)).rejects.toThrow("SDK call failed");
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
  });

  describe("an account that doesn't exist yet", () => {
    const XLM = { address: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" };

    // NEAR's RPC answer for an account that doesn't exist (live, 2026-10-27), which the SDK's client turns
    // into its own error.
    const nearUnknownAccount: typeof fetch = async (_url, init) => {
      const { id, params } = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: {
          name: "HANDLER_ERROR",
          cause: {
            name: "UNKNOWN_ACCOUNT",
            info: { requested_account_id: params.account_id, block_hash: "EK7bepCQ", block_height: 221773366 },
          },
          code: -32000,
          message: "Server error",
          data: `account ${params.account_id} does not exist while viewing`,
        },
      });
    };

    it('reads as null on Stellar by Horizon\'s 404, though stellar-sdk names its NotFoundError "Error"', async () => {
      const notFound = new stellar.NotFoundError("Not Found", { title: "Resource Missing", status: 404 });
      expect(notFound.name).toBe("Error");
      const load = vi.spyOn(stellar.Horizon.Server.prototype, "loadAccount").mockRejectedValueOnce(notFound);
      await expect(walletBalance("stellar", stellar.Keypair.random().publicKey(), XLM)).resolves.toBeNull();
      load.mockRejectedValueOnce(new stellar.NetworkError("Internal Server Error", { status: 500 }));
      await expect(walletBalance("stellar", stellar.Keypair.random().publicKey(), XLM)).rejects.toThrow(
        /^SDK call failed$/,
      );
    });

    it("reads as null on NEAR by the SDK's AccountDoesNotExistError", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(nearUnknownAccount);
      await expect(walletBalance("near", "nobody.near", { address: "NEAR" })).resolves.toBeNull();
    });

    it("is never read from a token: a NEAR token contract that doesn't exist fails the same way", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(nearUnknownAccount);
      await expect(walletBalance("near", "alice.near", { address: "no-such-token.near" })).rejects.toThrow(
        /^SDK call failed$/,
      );
    });

    it("is never read on another family, whatever the error looks like", async () => {
      const lookalike = Object.assign(new Error("x"), { name: "AccountDoesNotExistError", response: { status: 404 } });
      vi.spyOn(SpokeService.prototype, "getWalletBalance").mockResolvedValue({ ok: false, error: lookalike } as never);
      await expect(walletBalance("0xa4b1.arbitrum", USER, { address: `0x${"0".repeat(40)}` })).rejects.toThrow(
        /^SDK call failed$/,
      );
    });
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

describe("parseRpcOverrides", () => {
  it("maps SODAX_RPC_URL_<chainId> to the chain key, ignoring everything else", () => {
    const env = {
      SODAX_RPC_URL_42161: "https://arb.example/key",
      SODAX_RPC_URL_137: "",
      SODAX_RPC_URL: "https://no-id.example",
      PATH: "/bin",
    };
    expect(parseRpcOverrides(env)).toEqual({ "0xa4b1.arbitrum": "https://arb.example/key" });
  });

  it.each([
    ["SODAX_RPC_URL_42161", "http://arb.example/secret-key", "must be an https URL"],
    ["SODAX_RPC_URL_42161", "not a url secret-key", "must be an https URL"],
    ["SODAX_RPC_URL_999999", "https://nowhere.example/secret-key", "doesn't name a SODAX EVM chain id"],
  ])("stops on %s=%s, naming the variable and not its value", (name, value, reason) => {
    expect(() => parseRpcOverrides({ [name]: value })).toThrow(`${name} ${reason}`);
    expect(() => parseRpcOverrides({ [name]: value })).not.toThrow(/secret-key/);
  });
});

describe("connectionFor", () => {
  it("pins a spoke's connection from the packaged config, and has none for the hub", () => {
    expect(connectionFor("0xa4b1.arbitrum")).toBe("0x4555aC13D7338D9E671584C1D118c06B2a3C88eD");
    expect(connectionFor("sonic")).toBeUndefined();
    expect(connectionFor("not-a-chain")).toBeUndefined();
  });
});
