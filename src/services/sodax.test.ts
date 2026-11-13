import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EvmHubProvider, EvmSolverService, NearSpokeService, SpokeService, StellarSpokeService } from "@sodax/sdk";
import { solverConfig, spokeChainConfig } from "@sodax/types";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { INTENT } from "../tools/__fixtures__/swapBackend.js";
import { logger } from "./logger.js";
import {
  approveCalldata,
  blockNumber,
  bounded,
  cancelPayload,
  checksumValid,
  connectionFor,
  createIntentPayload,
  encodeRecipient,
  evmChainIdFor,
  initSodax,
  intentChainId,
  intentHash,
  packagedToken,
  parseRpcOverrides,
  rebuildSwapTx,
  recipientReady,
  sdkLogger,
  stellarRecipientCheckable,
  swapContractFor,
  userHubWallet,
  walletBalance,
} from "./sodax.js";

const USER = "0x000000000000000000000000000000000000dEaD";
// A Stellar token whose trustline the packaged config lists, which the SDK needs to check a recipient.
const LISTED = spokeChainConfig.stellar.trustlineConfigs[0].contractId;

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

describe("intentHash", () => {
  it("is the SDK's hash of the same struct with its numbers as bigints, the hub's id of the intent", () => {
    const hash = intentHash(INTENT);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).toBe(
      EvmSolverService.getIntentHash({
        ...INTENT,
        intentId: 7n,
        inputAmount: 5_000_000n,
        minOutputAmount: 4_941_968n,
        deadline: BigInt(INTENT.deadline),
        srcChain: 23n,
        dstChain: 146n,
      } as Parameters<typeof EvmSolverService.getIntentHash>[0]),
    );
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

describe("createIntentPayload", () => {
  it.each(["built-intent-usdc-fee.json", "built-intent-eth.json"] as const)(
    "is the payload a live spoke swap (%s) carries, byte for byte",
    name => {
      const { intent, relayData } = recorded(name);
      expect(createIntentPayload(intent)?.toLowerCase()).toBe(relayData.payload.toLowerCase());
    },
  );

  it("differs for another intent of the same wallet, and gives up on one the SDK can't encode", () => {
    const { intent } = recorded("built-intent-eth.json");
    expect(createIntentPayload({ ...intent, intentId: "8" })).not.toBe(createIntentPayload(intent));
    expect(createIntentPayload({ ...intent, intentId: "not a number" })).toBeUndefined();
  });
});

describe("stellarRecipientCheckable", () => {
  it("takes the tokens the SDK can check a Stellar recipient for, and nothing else", () => {
    const { nativeToken, supportedTokens } = spokeChainConfig.stellar;
    for (const token of [LISTED, LISTED.toLowerCase(), nativeToken, supportedTokens.legacybnUSD.address]) {
      expect(stellarRecipientCheckable(token)).toBe(true);
    }
    expect(stellarRecipientCheckable("CUNLISTED")).toBe(false);
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

  it("takes only a Stellar account and a Bitcoin mainnet address on those chains", () => {
    const stellar = "GDZZZV63F63EL63XSKXE6V535JYUW2WFO6VKLYH73LCOUJCUCDRFPNIW";
    expect(encodeRecipient("stellar", stellar)).toBeDefined();
    expect(encodeRecipient("stellar", spokeChainConfig.stellar.nativeToken)).toBeUndefined();
    expect(
      encodeRecipient("stellar", "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ"),
    ).toBeUndefined();
    expect(encodeRecipient("bitcoin", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBeDefined();
    expect(encodeRecipient("bitcoin", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBeUndefined();
    expect(encodeRecipient("bitcoin", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")).toBeUndefined();
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

  it("takes an all-lowercase address or a valid EIP-55 checksum, nothing else", () => {
    expect(checksumValid(USER)).toBe(true);
    expect(checksumValid("0x000000000000000000000000000000000000DEad")).toBe(false);
    expect(checksumValid(USER.toLowerCase())).toBe(true);
    expect(checksumValid(`0x${USER.slice(2).toUpperCase()}`)).toBe(false);
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
    await expect(recipientReady("STELLAR", LISTED, "GABC", 5n)).resolves.toBe(false);
    expect(trustline).toHaveBeenCalledWith(LISTED, 5n, "GABC");
  });

  it("read a missing Stellar account as not ready", async () => {
    const trustline = vi.spyOn(StellarSpokeService.prototype, "hasSufficientTrustline");
    trustline.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { response: { status: 404 } }));
    await expect(recipientReady("STELLAR", LISTED, "GABC", 5n)).resolves.toBe(false);
    trustline.mockRejectedValueOnce(Object.assign(new Error("Bad Gateway"), { response: { status: 502 } }));
    await expect(recipientReady("STELLAR", LISTED, "GABC", 5n)).rejects.toThrow(/^SDK call failed$/);
  });

  it("needs an existing Stellar account for XLM, which takes no trustline", async () => {
    const { nativeToken } = spokeChainConfig.stellar;
    const read = vi.spyOn(StellarSpokeService.prototype, "getWalletBalance");
    read.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { response: { status: 404 } }));
    await expect(recipientReady("STELLAR", nativeToken, "GABC", 5n)).resolves.toBe(false);
    read.mockResolvedValueOnce(0n);
    await expect(recipientReady("STELLAR", nativeToken, "GABC", 5n)).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
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
  it("passes on only the SDK's message, never its error or data, under one constant body", () => {
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    sdkLogger.debug();
    sdkLogger.info();
    sdkLogger.warn("balance read failed");
    sdkLogger.error("rpc failed");
    expect(warn).toHaveBeenCalledWith({ "sdk.message": "balance read failed" }, "SODAX SDK warning");
    expect(error).toHaveBeenCalledWith({ "sdk.message": "rpc failed" }, "SODAX SDK error");
  });

  it("passes the message on without URLs", () => {
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    sdkLogger.warn("read from https://rpc.example/KEY failed");
    sdkLogger.error("socket wss://rpc.example/KEY closed");
    expect(warn).toHaveBeenCalledWith({ "sdk.message": "read from <url> failed" }, "SODAX SDK warning");
    expect(error).toHaveBeenCalledWith({ "sdk.message": "socket <url> closed" }, "SODAX SDK error");
  });
});

describe("parseRpcOverrides", () => {
  const rpcConfig = (config: unknown) => ({ RPC_CONFIG: JSON.stringify(config) });
  const quiet = () => vi.spyOn(logger, "warn").mockImplementation(() => undefined);

  it("reads RPC_CONFIG by chain key, in the SDK's field names, ignoring other variables", () => {
    const want = {
      "0xa4b1.arbitrum": { rpcUrl: "https://arb.example/key" },
      sui: { grpc_url: "https://sui.example/key" },
      stellar: { horizonRpcUrl: "https://horizon.example", sorobanRpcUrl: "https://soroban.example/key" },
    };
    expect(parseRpcOverrides({ ...rpcConfig(want), PATH: "/bin" })).toEqual(want);
  });

  it("takes the value as an env value may hold it: single-quoted, or with escaped quotes", () => {
    const want = { sonic: { rpcUrl: "https://sonic.example" } };
    expect(parseRpcOverrides({ RPC_CONFIG: `'{"sonic":{"rpcUrl":"https://sonic.example"}}'` })).toEqual(want);
    expect(parseRpcOverrides({ RPC_CONFIG: '{\\"sonic\\":{\\"rpcUrl\\":\\"https://sonic.example\\"}}' })).toEqual(want);
  });

  it("takes the backend format's documented example as is, every chain, without a warning", () => {
    const warn = quiet();
    const example = {
      sonic: { rpcUrl: "https://rpc.soniclabs.com" },
      ethereum: { rpcUrl: "https://eth.merkle.io" },
      "0xa86a.avax": { rpcUrl: "https://api.avax.network/ext/bc/C/rpc" },
      "0xa4b1.arbitrum": { rpcUrl: "https://arb1.arbitrum.io/rpc" },
      "0x2105.base": { rpcUrl: "https://mainnet.base.org" },
      "0xa.optimism": { rpcUrl: "https://mainnet.optimism.io" },
      "0x38.bsc": { rpcUrl: "https://56.rpc.thirdweb.com" },
      "0x89.polygon": { rpcUrl: "https://polygon-rpc.com" },
      "0x2019.kaia": { rpcUrl: "https://public-en.node.kaia.io" },
      hyper: { rpcUrl: "https://rpc.hyperliquid.xyz/evm" },
      lightlink: { rpcUrl: "https://replicator.phoenix.lightlink.io/rpc/v1" },
      redbelly: { rpcUrl: "https://governors.mainnet.redbelly.network" },
      near: { rpcUrl: "https://1rpc.io/near" },
      solana: { rpcUrl: "https://api.mainnet-beta.solana.com" },
      "injective-1": { rpcUrl: "https://injective-rpc.publicnode.com:443" },
      bitcoin: { rpcUrl: "https://mempool.space/api" },
      stacks: { rpcUrl: "https://api.mainnet.hiro.so" },
      hedera: { rpcUrl: "https://mainnet.hashio.io/api" },
      sui: { grpc_url: "https://fullnode.mainnet.sui.io" },
      stellar: { horizonRpcUrl: "https://horizon.stellar.org", sorobanRpcUrl: "https://rpc.ankr.com/stellar_soroban" },
      "0x1.icon": { rpcUrl: "https://ctz.solidwallet.io/api/v3", debugRpcUrl: "https://ctz.solidwallet.io/api/v3d" },
    };
    expect(parseRpcOverrides(rpcConfig(example))).toEqual(example);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the packaged RPC without RPC_CONFIG, and for a chain or field it leaves out or leaves blank", () => {
    const warn = quiet();
    for (const RPC_CONFIG of [undefined, "", "  "]) expect(parseRpcOverrides({ RPC_CONFIG })).toEqual({});
    // A workflow writes an unset secret as "".
    expect(parseRpcOverrides(rpcConfig({ "0x2105.base": { rpcUrl: "" } }))).toEqual({});
    expect(parseRpcOverrides(rpcConfig({ stellar: { horizonRpcUrl: "https://horizon.example" } }))).toEqual({
      stellar: { horizonRpcUrl: "https://horizon.example" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips what it can't apply with one warning naming it, never its value, and never stops", () => {
    const warn = quiet();
    const overrides = parseRpcOverrides(
      rpcConfig({
        sonic: { rpcUrl: "https://sonic.example" },
        "a-newer-sdks-chain": { rpcUrl: "https://new.example/secret-key" },
        sui: { rpc_url: "https://sui.example/secret-key" },
        "0x1.icon": { rpc_url: "https://icon.example/secret-key" },
        ethereum: { rpcUrl: "http://eth.example/secret-key" },
        "0x89.polygon": { rpcUrl: "not a url secret-key" },
        hedera: "https://hedera.example/secret-key",
      }),
    );
    expect(overrides).toEqual({ sonic: { rpcUrl: "https://sonic.example" } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        "rpc_config.skipped":
          "a-newer-sdks-chain, sui.rpc_url, 0x1.icon.rpc_url, ethereum.rpcUrl, 0x89.polygon.rpcUrl, hedera",
      },
      "RPC_CONFIG entries this server can't apply",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-key");
  });

  // Solana's client refuses some of these when the SDK is built, which would stop the boot; the log redaction
  // misses a URL without `//`, and stops at `'` or `<`, which would show a key.
  it.each([
    "HTTPS://x.example/secret-key",
    "https:x.example/secret-key",
    "https:/x.example/secret-key",
    "https://",
    "https://x.example/v1/abc'secret-key",
    "https://x.example/<secret-key>",
  ])("skips %j: only an https:// URL as written is taken", rpcUrl => {
    quiet();
    expect(parseRpcOverrides(rpcConfig({ solana: { rpcUrl } }))).toEqual({});
  });

  it("never names a key or field that isn't shaped like one: a URL pasted as a key stays out of the log", () => {
    const warn = quiet();
    parseRpcOverrides(
      rpcConfig({
        "https://polygon.example/v2/secret-key": { rpcUrl: "https://x.example" },
        sonic: { "https://rpc.example/secret-key": true },
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      { "rpc_config.skipped": "(an unknown key), sonic.(an unknown field)" },
      "RPC_CONFIG entries this server can't apply",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-key");
  });

  it("takes a URL with surrounding whitespace, as a secret set from a file has, trimmed", () => {
    expect(parseRpcOverrides(rpcConfig({ sonic: { rpcUrl: " https://sonic.example/key\n" } }))).toEqual({
      sonic: { rpcUrl: "https://sonic.example/key" },
    });
  });

  it.each(["not json secret-key", "[]", "null", '"https://x.example/secret-key"'])(
    "keeps every packaged RPC when RPC_CONFIG is %s, with a warning that doesn't echo it",
    RPC_CONFIG => {
      const warn = quiet();
      expect(parseRpcOverrides({ RPC_CONFIG })).toEqual({});
      expect(warn).toHaveBeenCalledWith("RPC_CONFIG isn't a JSON object; every chain uses its packaged RPC");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-key");
    },
  );

  it("names any old SODAX_RPC_URL_* variable still set, never its value", () => {
    const warn = quiet();
    expect(parseRpcOverrides({ SODAX_RPC_URL_137: "https://polygon.example/secret-key" })).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      { "rpc_config.legacy": "SODAX_RPC_URL_137" },
      "SODAX_RPC_URL_* is no longer read: set RPC_CONFIG",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-key");
  });

  it("takes per chain the fields the SDK reads, as checked in its build", () => {
    // What @sodax/sdk reads, family by family; Injective's rpcUrl is taken but unread (fixed mainnet endpoints).
    const reads: Record<string, string[]> = {
      SOLANA: ["rpcUrl"],
      NEAR: ["rpcUrl"],
      BITCOIN: ["rpcUrl"],
      STACKS: ["rpcUrl"],
      ICON: ["rpcUrl", "debugRpcUrl"],
      SUI: ["grpc_url"],
      STELLAR: ["horizonRpcUrl", "sorobanRpcUrl"],
      INJECTIVE: ["rpcUrl"],
      EVM: ["rpcUrl"],
    };
    // rpc_url included: no packaged config has it, so no chain takes it.
    const fields = ["rpcUrl", "rpc_url", "grpc_url", "debugRpcUrl", "horizonRpcUrl", "sorobanRpcUrl"];
    const all = Object.fromEntries(fields.map(field => [field, "https://x.example"]));
    quiet();
    for (const [chainKey, config] of Object.entries(spokeChainConfig)) {
      const taken = Object.keys(parseRpcOverrides(rpcConfig({ [chainKey]: all }))[chainKey] ?? {});
      expect(taken, chainKey).toEqual(reads[config.chain.type]);
    }
  });
});

describe("initSodax", () => {
  it("sends the hub's reads through a Sonic override too", async () => {
    vi.resetModules();
    const fresh = await import("./sodax.js");
    await fresh.initSodax({ sonic: { rpcUrl: "https://sonic.example/key" } });
    // A 400, which viem doesn't retry.
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    await expect(fresh.userHubWallet("0xa4b1.arbitrum", USER)).rejects.toThrow("SDK call failed");
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain("https://sonic.example/key");
  });

  it("sends a non-EVM chain's reads through its override", async () => {
    vi.resetModules();
    const fresh = await import("./sodax.js");
    await fresh.initSodax({ near: { rpcUrl: "https://near.example/key" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    await expect(fresh.recipientReady("NEAR", "usdc.near", "alice.near", 1n)).rejects.toThrow("SDK call failed");
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain("https://near.example/key");
  });
});

describe("blockNumber", () => {
  it("reads NEAR's final block, so a quote finds a dead NEAR RPC before the user sends anything", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { id } = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id, result: { header: { height: 12345 } } });
    });
    expect(await blockNumber("near")).toBe(12345n);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      method: "block",
      params: { finality: "final" },
    });
  });
});

describe("connectionFor", () => {
  it("pins a spoke's connection from the packaged config, and has none for the hub", () => {
    expect(connectionFor("0xa4b1.arbitrum")).toBe("0x4555aC13D7338D9E671584C1D118c06B2a3C88eD");
    expect(connectionFor("sonic")).toBeUndefined();
    expect(connectionFor("not-a-chain")).toBeUndefined();
  });
});

describe("chain read records", () => {
  it("logs what was read, where and how long, and a timeout by its name", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    await expect(bounded({ label: "receipt", chainKey: "sonic" }, () => Promise.resolve(1))).resolves.toBe(1);
    expect(info).toHaveBeenCalledWith(
      { "sdk.call": "receipt", "chain.key": "sonic", "duration.ms": expect.any(Number) },
      "Chain read",
    );
    await expect(bounded({ label: "balance", timeoutMs: 1 }, () => new Promise(() => {}))).rejects.toThrow(
      "SDK call failed",
    );
    expect(warn).toHaveBeenCalledWith(
      {
        "sdk.call": "balance",
        "chain.key": undefined,
        "duration.ms": expect.any(Number),
        "error.type": "TimeoutError",
      },
      "Chain read",
    );
  });
});
