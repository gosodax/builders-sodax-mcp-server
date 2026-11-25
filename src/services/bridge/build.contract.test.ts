/**
 * The Bridge API's builds against the SDK's, live: `pnpm test:contract`. Unsigned builds only, nothing is sent. Both
 * run the same SDK on the same packaged config, so a refusal here means they no longer do (a version apart), or one
 * builds a bridge differently. From EVM chains, 0x…dEaD holds the tokens; from the others, the wallets of the
 * recorded swap fixtures send their chain's native coin.
 */

import { spokeChainConfig } from "@sodax/types";
import { beforeAll, describe, expect, it } from "vitest";
import { bridgeableTokensTo, decodeAddress, initSodax } from "../sodax.js";
import fixtures from "../swap/__fixtures__/non-evm-txs.json" with { type: "json" };
import { toChain } from "../swap/resolver.js";
import { pinnedSourceOf } from "../swap/sources/index.js";
import type { BridgeRequest } from "./bridgeApi.js";
import { buildEvmBridge, buildNonEvmBridge } from "./build.js";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

beforeAll(() => initSodax());

const evm = (request: Partial<BridgeRequest>): BridgeRequest => ({
  srcChainKey: "0xa4b1.arbitrum",
  dstChainKey: "0x2105.base",
  inputToken: ARB_USDC,
  outputToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  inputAmount: 1_000_000n,
  srcAddress: DEAD,
  dstAddress: DEAD,
  ...request,
});

describe("bridge builds from EVM chains and Sonic, byte for byte", () => {
  it.each([
    ["USDC, Arbitrum to Base", evm({}), false],
    ["USDC with a partner fee", evm({ partnerFee: { address: `0x${"0".repeat(39)}1`, bps: 25 } }), false],
    ["native ETH", evm({ inputToken: ZERO, outputToken: ZERO, inputAmount: 10n ** 15n }), true],
    [
      "native HBAR from Hedera, its value scaled",
      evm({
        srcChainKey: "hedera",
        dstChainKey: "sonic",
        inputToken: ZERO,
        outputToken: "0x3BB956cc8922E1Ba4148dc10eD1b4Fa19aa599c4",
        inputAmount: 100_000_000n,
      }),
      true,
    ],
    [
      "USDC from Sonic, through the wallet router",
      evm({
        srcChainKey: "sonic",
        dstChainKey: "0xa86a.avax",
        inputToken: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
        outputToken: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      }),
      false,
    ],
  ] as const)("%s", async (_, request, native) => {
    const { deposit, approvals } = await buildEvmBridge(request, native);
    expect(deposit.from).toBe(DEAD);
    expect(approvals.length > 0).toBe(!native);
  });
});

describe("bridge builds from non-EVM chains: the relay data both agree on", () => {
  const fixtureOf = (chainKey: string) =>
    chainKey === "injective-1" ? fixtures.injective : fixtures[chainKey as "sui"];

  it.each([
    ["solana", 10_000_000n],
    ["sui", 100_000_000n],
    ["near", 10n ** 22n],
    ["stellar", 10_000_000n],
    ["injective-1", 10n ** 16n],
  ] as const)("%s native coin to Sonic", async (chainKey, amount) => {
    const native = spokeChainConfig[chainKey].nativeToken;
    const [dstToken] = bridgeableTokensTo({ chainKey, address: native }, "sonic");
    const source = pinnedSourceOf(chainKey);
    if (!source || !dstToken) throw new Error(`no source or no Sonic token for ${chainKey}`);
    const { step } = await buildNonEvmBridge(
      {
        srcChainKey: chainKey,
        dstChainKey: "sonic",
        inputToken: native,
        outputToken: dstToken,
        inputAmount: amount,
        srcAddress: decodeAddress(chainKey, fixtureOf(chainKey).intent.srcAddress) as string,
        dstAddress: DEAD,
      },
      { ...source, chain: toChain(chainKey) },
      "native",
    );
    expect(step).toMatchObject({ kind: "bridge", chainKey });
  });
});
