import { spokeChainConfig } from "@sodax/types";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { base58Bytes } from "../../constants.js";
import { initSodax, sdkBridge } from "../sodax.js";
// The SDK's own deposit builds, recorded live: the program a bridge deposit calls is a swap deposit's.
import builds from "../swap/__fixtures__/non-evm-builds.json" with { type: "json" };
import type { ActionError } from "../swap/errors.js";
import { toChain } from "../swap/resolver.js";
import { pinnedSourceOf } from "../swap/sources/index.js";
import type { SwapSource } from "../swap/sources/types.js";
import type { BridgeRequest } from "./bridgeApi.js";
import { buildNonEvmBridge } from "./build.js";

// The SDK's build reads the source chain: it is scripted per test.
vi.mock("../sodax.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../sodax.js")>()),
  sdkBridge: vi.fn(),
}));

beforeAll(() => initSodax());

const sourceOf = (chainKey: string): SwapSource => ({
  ...(pinnedSourceOf(chainKey) as NonNullable<ReturnType<typeof pinnedSourceOf>>),
  chain: toChain(chainKey),
});
const requestFrom = (srcChainKey: string): BridgeRequest => ({
  srcChainKey,
  dstChainKey: "0xa4b1.arbitrum",
  inputToken: "token",
  outputToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  inputAmount: 1000n,
  srcAddress: "user",
  dstAddress: `0x${"4".repeat(40)}`,
});
const RELAY = { address: `0x${"c".repeat(40)}`, payload: "0x0102" };

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(sdkBridge).mockReset();
});

/** The Bridge API: its own build (only its relay data and target are read) and its allowance check. */
function bridgeApi(intents: { tx: unknown; relayData: unknown }, allowance = true) {
  fetchSpy.mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith("/intents")) return new Response(JSON.stringify(intents));
    if (url.endsWith("/allowance/check")) return new Response(JSON.stringify({ valid: allowance }));
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function refusal(chainKey: string): Promise<ActionError> {
  return buildNonEvmBridge(requestFrom(chainKey), sourceOf(chainKey), "TKN").catch((error: ActionError) => error);
}

describe("buildNonEvmBridge", () => {
  it("returns the SDK's deposit as the step, once both builds name the same relay data", async () => {
    vi.mocked(sdkBridge).mockResolvedValue({ tx: builds.solana.deposit, relayData: RELAY });
    bridgeApi({ tx: { other: "build" }, relayData: RELAY });
    const { step, relayData } = await buildNonEvmBridge(requestFrom("solana"), sourceOf("solana"), "TKN");
    expect(step).toMatchObject({ kind: "bridge", chainKey: "solana", chainType: "SOLANA" });
    expect(relayData).toEqual(RELAY);
  });

  it.each([
    ["address", { ...RELAY, address: `0x${"d".repeat(40)}` }],
    ["payload", { ...RELAY, payload: "0x0103" }],
  ])("refuses relay data whose %s differs from the SDK's", async (_, relayData) => {
    vi.mocked(sdkBridge).mockResolvedValue({ tx: builds.solana.deposit, relayData: RELAY });
    bridgeApi({ tx: {}, relayData });
    expect((await refusal("solana")).code).toBe("BRIDGE_MISMATCH");
  });

  it("from Solana, refuses a deposit to another program than the packaged asset manager", async () => {
    const bytes = Buffer.from(builds.solana.deposit.data, "base64");
    const id = Buffer.from(base58Bytes(spokeChainConfig.solana.addresses.assetManager));
    bytes.set(new Uint8Array(32).fill(7), bytes.indexOf(id));
    vi.mocked(sdkBridge).mockResolvedValue({
      tx: { ...builds.solana.deposit, data: bytes.toString("base64") },
      relayData: RELAY,
    });
    bridgeApi({ tx: {}, relayData: RELAY });
    expect((await refusal("solana")).code).toBe("BRIDGE_MISMATCH");
  });

  it("from Sui, signs a call to the package the Bridge API's own build names, and only that one", async () => {
    const sui = builds.sui.deposit;
    vi.mocked(sdkBridge).mockResolvedValue({ tx: sui, relayData: RELAY });
    bridgeApi({ tx: { to: sui.to }, relayData: RELAY });
    const { step } = await buildNonEvmBridge(requestFrom("sui"), sourceOf("sui"), "TKN");
    // With its sender set, so no other account's wallet signs it.
    expect(JSON.parse((step.tx as { data: string }).data)).toEqual({ ...JSON.parse(sui.data), sender: sui.from });
    bridgeApi({ tx: { to: "0xbad::asset_manager::transfer" }, relayData: RELAY });
    expect((await refusal("sui")).code).toBe("BRIDGE_MISMATCH");
  });

  it("from Stellar, asks for trustline room when the allowance is short", async () => {
    vi.mocked(sdkBridge).mockResolvedValue({ tx: {}, relayData: RELAY });
    bridgeApi({ tx: {}, relayData: RELAY }, false);
    const error = await refusal("stellar");
    expect(error.code).toBe("BRIDGE_REJECTED");
    expect(error.details).toEqual({ reason: "trustline_room" });
  });

  it("refuses an approval it can't build elsewhere", async () => {
    vi.mocked(sdkBridge).mockResolvedValue({ tx: {}, relayData: RELAY });
    bridgeApi({ tx: {}, relayData: RELAY }, false);
    expect((await refusal("near")).details).toEqual({ reason: "approval_unbuildable" });
  });

  it("is CHAIN_UNAVAILABLE when the SDK can't build it", async () => {
    vi.mocked(sdkBridge).mockRejectedValue(new Error("SDK call failed"));
    bridgeApi({ tx: {}, relayData: RELAY });
    const error = await refusal("sui");
    expect(error.code).toBe("CHAIN_UNAVAILABLE");
    expect(error.nextStep).toContain("sodax_bridge_prepare");
  });
});
