import { EvmHubProvider, sonicWalletFactoryAbi, spokeAssetManagerAbi } from "@sodax/sdk";
import { spokeChainConfig } from "@sodax/types";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkRefusal, approveCalldata, bridgeableTokensTo, initSodax, sdkBridge, swapContractFor } from "../sodax.js";
import { ActionError } from "../swap/errors.js";
import { toChain } from "../swap/resolver.js";
import { pinnedSourceOf } from "../swap/sources/index.js";
import { findToken } from "../swap/tokens.js";
import type { BridgeRequest } from "./bridgeApi.js";
import { buildEvmBridge } from "./build.js";
import { getBridgeCatalog } from "./catalog.js";

const USER = "0x1234567890123456789012345678901234567890";
const RECIPIENT = `0x${"4".repeat(40)}`;
// The user's hub wallet, as the stubbed hub read returns it.
const HUB_WALLET = `0x${"c".repeat(40)}`;
const ZERO = `0x${"0".repeat(40)}`;

const ARB_TO_BASE_USDC: BridgeRequest = {
  srcChainKey: "0xa4b1.arbitrum",
  dstChainKey: "0x2105.base",
  srcToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  dstToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: 5_000_000n,
  srcAddress: USER,
  recipient: RECIPIENT,
};
const HEDERA_HBAR_TO_SONIC: BridgeRequest = {
  ...ARB_TO_BASE_USDC,
  srcChainKey: "hedera",
  dstChainKey: "sonic",
  srcToken: ZERO,
  dstToken: "0x3BB956cc8922E1Ba4148dc10eD1b4Fa19aa599c4",
  amount: 100_000_000n,
};
const SONIC_USDC_TO_AVAX: BridgeRequest = {
  ...ARB_TO_BASE_USDC,
  srcChainKey: "sonic",
  dstChainKey: "0xa86a.avax",
  srcToken: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
  dstToken: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
};
const SONIC_S_TO_LIGHTLINK: BridgeRequest = {
  ...ARB_TO_BASE_USDC,
  srcChainKey: "sonic",
  dstChainKey: "lightlink",
  srcToken: ZERO,
  dstToken: "0xb3A47798CB6585Ea0d31a7986f2a04b25C60247f",
  amount: 10n ** 18n,
};

beforeAll(() => initSodax());

/** The build from the request's pinned source, its token as the bridge catalog lists it. */
function build(request: BridgeRequest) {
  const source = pinnedSourceOf(request.srcChainKey);
  const token = findToken(getBridgeCatalog(), request.srcChainKey, request.srcToken);
  if (!source || !token) throw new Error(`no source or no token on ${request.srcChainKey}`);
  return buildEvmBridge(request, { ...source, chain: toChain(request.srcChainKey) }, token);
}

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  vi.spyOn(EvmHubProvider.prototype, "getUserHubWalletAddress").mockResolvedValue(HUB_WALLET);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the SDK builds for the request: what an honest Bridge API answers, its value as a decimal string. */
async function honestBuild(request: BridgeRequest) {
  const { tx, relayData } = await sdkBridge({
    srcChainKey: request.srcChainKey,
    srcAddress: request.srcAddress,
    srcToken: request.srcToken,
    amount: request.amount,
    dstChainKey: request.dstChainKey,
    dstToken: request.dstToken,
    recipient: request.recipient,
    partnerFee: request.partnerFee,
  });
  const { value, ...rest } = tx as { from: string; to: string; value: bigint; data: string };
  return { tx: { ...rest, value: value.toString() }, relayData };
}

/** The Bridge API, answering each route with what it's given. */
function bridgeApi(answers: { intents: unknown; allowance?: boolean; approve?: unknown }) {
  fetchSpy.mockImplementation(async input => {
    const url = String(input);
    const body = url.endsWith("/intents")
      ? answers.intents
      : url.endsWith("/allowance/check")
        ? { valid: answers.allowance ?? true }
        : url.endsWith("/approve")
          ? answers.approve
          : undefined;
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(body));
  });
}

const calledRoutes = () => fetchSpy.mock.calls.map(([input]) => new URL(String(input)).pathname);
const approveTx = (token: string, spender: string, amount: bigint) => ({
  from: USER,
  to: token,
  value: "0",
  data: approveCalldata(token, spender, amount),
});

async function mismatch(request: BridgeRequest): Promise<ActionError> {
  const error = await build(request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ActionError);
  expect((error as ActionError).code).toBe("BRIDGE_MISMATCH");
  return error as ActionError;
}

describe("buildEvmBridge from an EVM spoke", () => {
  it("returns the Bridge API's build when it is the SDK's, byte for byte", async () => {
    const built = await honestBuild(ARB_TO_BASE_USDC);
    bridgeApi({ intents: built });
    const checked = await build(ARB_TO_BASE_USDC);
    expect(checked).toMatchObject({ deposit: built.tx, relayData: built.relayData });
    expect(checked.steps).toEqual([
      { kind: "bridge", chainId: 42161, tx: { ...built.tx, value: "0x0", chainId: "0xa4b1" } },
    ]);
  });

  it("is the deposit the SDK builds: transfer(token, hub wallet, amount, payload) on the asset manager", async () => {
    const built = await honestBuild(ARB_TO_BASE_USDC);
    expect(built.tx.to).toBe(swapContractFor("0xa4b1.arbitrum"));
    const { args } = decodeFunctionData({ abi: spokeAssetManagerAbi, data: built.tx.data as `0x${string}` });
    expect(args).toEqual([ARB_TO_BASE_USDC.srcToken, HUB_WALLET, 5_000_000n, built.relayData.payload]);
    expect(built.relayData.address).toBe(HUB_WALLET);
    // The hub calls end with the transfer to the recipient.
    expect(built.relayData.payload.toLowerCase()).toContain(RECIPIENT.slice(2));
  });

  it.each([
    ["tx.from", { from: RECIPIENT }],
    ["tx.to", { to: RECIPIENT }],
    ["tx.value", { value: "1" }],
    ["tx.data", { data: "0x" }],
  ])("refuses a deposit whose %s differs", async (_, change) => {
    const built = await honestBuild(ARB_TO_BASE_USDC);
    bridgeApi({ intents: { ...built, tx: { ...built.tx, ...change } } });
    await mismatch(ARB_TO_BASE_USDC);
  });

  it.each([
    ["address", { address: RECIPIENT }],
    ["payload", { payload: "0xdeadbeef" }],
  ])("refuses relay data whose %s differs", async (_, change) => {
    const built = await honestBuild(ARB_TO_BASE_USDC);
    bridgeApi({ intents: { ...built, relayData: { ...built.relayData, ...change } } });
    await mismatch(ARB_TO_BASE_USDC);
  });

  it("refuses a tx that isn't an EVM one", async () => {
    const built = await honestBuild(ARB_TO_BASE_USDC);
    bridgeApi({ intents: { ...built, tx: { instructions: [] } } });
    await mismatch(ARB_TO_BASE_USDC);
  });

  it("refuses a build made for another bridge: the same pair to another recipient", async () => {
    const other = await honestBuild({ ...ARB_TO_BASE_USDC, recipient: USER });
    bridgeApi({ intents: other });
    await mismatch(ARB_TO_BASE_USDC);
  });
});

describe("approvals", () => {
  it("asks for none for the native token", async () => {
    bridgeApi({ intents: await honestBuild(HEDERA_HBAR_TO_SONIC) });
    await build(HEDERA_HBAR_TO_SONIC);
    expect(calledRoutes()).toEqual(["/v1/bridge/intents"]);
  });

  it("returns the approve, for the asset manager the deposit calls, when the allowance is short", async () => {
    const assetManager = swapContractFor("0xa4b1.arbitrum") as string;
    const approve = approveTx(ARB_TO_BASE_USDC.srcToken, assetManager, 5_000_000n);
    bridgeApi({ intents: await honestBuild(ARB_TO_BASE_USDC), allowance: false, approve: { tx: approve } });
    const { steps } = await build(ARB_TO_BASE_USDC);
    expect(steps.map(({ kind }) => kind)).toEqual(["approve", "bridge"]);
    expect(steps[0]).toMatchObject({
      tx: { to: approve.to, data: approve.data },
      approves: { token: approve.to, symbol: "USDC", spender: assetManager, amount: "5" },
    });
  });

  it("puts a reset to zero first when the API returns one", async () => {
    const assetManager = swapContractFor("0xa4b1.arbitrum") as string;
    const approve = approveTx(ARB_TO_BASE_USDC.srcToken, assetManager, 5_000_000n);
    const reset = approveTx(ARB_TO_BASE_USDC.srcToken, assetManager, 0n);
    bridgeApi({
      intents: await honestBuild(ARB_TO_BASE_USDC),
      allowance: false,
      approve: { tx: approve, resetTx: reset },
    });
    const { steps } = await build(ARB_TO_BASE_USDC);
    expect(steps.map(({ kind }) => kind)).toEqual(["reset_approve", "approve", "bridge"]);
    expect(steps[0]?.approves?.amount).toBe("0");
  });

  it.each([
    ["another spender", (token: string, spender: string) => approveTx(token, RECIPIENT, 5_000_000n), false],
    ["more than the amount", (token: string, spender: string) => approveTx(token, spender, 10n ** 30n), false],
    ["another token", (_: string, spender: string) => approveTx(RECIPIENT, spender, 5_000_000n), false],
    ["a reset that isn't to zero", (token: string, spender: string) => approveTx(token, spender, 1n), true],
  ])("refuses an approve for %s", async (_, make, asReset) => {
    const assetManager = swapContractFor("0xa4b1.arbitrum") as string;
    const good = approveTx(ARB_TO_BASE_USDC.srcToken, assetManager, 5_000_000n);
    const bad = make(ARB_TO_BASE_USDC.srcToken, assetManager);
    const approve = asReset ? { tx: good, resetTx: bad } : { tx: bad };
    bridgeApi({ intents: await honestBuild(ARB_TO_BASE_USDC), allowance: false, approve });
    await mismatch(ARB_TO_BASE_USDC);
  });
});

describe("chain specifics", () => {
  it("scales Hedera's native value as the SDK does (10^10), and refuses it unscaled", async () => {
    const built = await honestBuild(HEDERA_HBAR_TO_SONIC);
    expect(built.tx.value).toBe((100_000_000n * 10n ** 10n).toString());
    bridgeApi({ intents: built });
    await expect(build(HEDERA_HBAR_TO_SONIC)).resolves.toMatchObject({ deposit: built.tx });
    bridgeApi({ intents: { ...built, tx: { ...built.tx, value: "100000000" } } });
    const error = await build(HEDERA_HBAR_TO_SONIC).catch((caught: unknown) => caught);
    expect((error as ActionError).code).toBe("BRIDGE_MISMATCH");
  });

  it("from Sonic, approves the user's hub wallet, which pulls the token through the wallet router", async () => {
    const built = await honestBuild(SONIC_USDC_TO_AVAX);
    const approve = approveTx(SONIC_USDC_TO_AVAX.srcToken, HUB_WALLET, 5_000_000n);
    bridgeApi({ intents: built, allowance: false, approve: { tx: approve } });
    const { steps } = await build(SONIC_USDC_TO_AVAX);
    expect(steps.map(({ kind }) => kind)).toEqual(["approve", "bridge"]);
    expect(steps[0]).toMatchObject({ tx: { data: approve.data }, approves: { spender: HUB_WALLET, amount: "5" } });
  });

  it("from Sonic, refuses a route with a call added", async () => {
    const built = await honestBuild(SONIC_USDC_TO_AVAX);
    const { functionName, args } = decodeFunctionData({
      abi: sonicWalletFactoryAbi,
      data: built.tx.data as `0x${string}`,
    });
    expect(functionName).toBe("route");
    const [calls] = args as unknown as [{ addr: `0x${string}`; value: bigint; data: `0x${string}` }[]];
    // The route pulls the token first (transferFrom), then makes the bridge's hub calls.
    expect(calls[0]?.addr.toLowerCase()).toBe(SONIC_USDC_TO_AVAX.srcToken.toLowerCase());
    const extra = { addr: RECIPIENT as `0x${string}`, value: 0n, data: "0x" as `0x${string}` };
    const data = encodeFunctionData({ abi: sonicWalletFactoryAbi, functionName: "route", args: [[...calls, extra]] });
    bridgeApi({ intents: { ...built, tx: { ...built.tx, data } } });
    await mismatch(SONIC_USDC_TO_AVAX);
  });

  it("sends native S with its value, wrapped by the route", async () => {
    const built = await honestBuild(SONIC_S_TO_LIGHTLINK);
    expect(built.tx.value).toBe((10n ** 18n).toString());
    bridgeApi({ intents: built });
    await expect(build(SONIC_S_TO_LIGHTLINK)).resolves.toMatchObject({ steps: [{ kind: "bridge" }] });
    bridgeApi({ intents: { ...built, tx: { ...built.tx, value: "0" } } });
    const error = await build(SONIC_S_TO_LIGHTLINK).catch((caught: unknown) => caught);
    expect((error as ActionError).code).toBe("BRIDGE_MISMATCH");
  });
});

describe("the SDK's own refusals", () => {
  it("refuses a Bitcoin delivery below dust as the SDK does, naming the amount", async () => {
    const btc = spokeChainConfig.bitcoin.nativeToken;
    const from = Object.values(spokeChainConfig["0xa4b1.arbitrum"].supportedTokens).find(token =>
      bridgeableTokensTo({ chainKey: "0xa4b1.arbitrum", address: token.address }, "bitcoin").some(
        address => address.toLowerCase() === btc.toLowerCase(),
      ),
    );
    if (!from) throw new Error("nothing on Arbitrum bridges to BTC");
    const request = {
      srcChainKey: "0xa4b1.arbitrum",
      srcAddress: USER,
      srcToken: from.address,
      amount: 1n,
      dstChainKey: "bitcoin",
      dstToken: btc,
      recipient: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    };
    const refused = await sdkBridge(request).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SdkRefusal);
    expect((refused as SdkRefusal).field).toBe("amount");
  });
});

describe("partner fee", () => {
  const withFee: BridgeRequest = { ...ARB_TO_BASE_USDC, partnerFee: { address: `0x${"a".repeat(40)}`, bps: 25 } };

  it("passes a build that takes the connection's fee, and refuses one that doesn't", async () => {
    bridgeApi({ intents: await honestBuild(withFee) });
    await expect(build(withFee)).resolves.toBeDefined();
    bridgeApi({ intents: await honestBuild(ARB_TO_BASE_USDC) });
    await mismatch(withFee);
  });
});

it("is CHAIN_UNAVAILABLE when the hub can't be read", async () => {
  vi.mocked(EvmHubProvider.prototype.getUserHubWalletAddress).mockRejectedValue(new Error("rpc down"));
  bridgeApi({ intents: { tx: {}, relayData: { address: HUB_WALLET, payload: "0x" } } });
  const error = await build(ARB_TO_BASE_USDC).catch((caught: unknown) => caught);
  expect((error as ActionError).code).toBe("CHAIN_UNAVAILABLE");
});
