import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeAmounts, bridgeLimit } from "../sodax.js";
import { ActionError } from "../swap/errors.js";
import { resolveExactly } from "../swap/resolver.js";
import { getBridgeCatalog } from "./catalog.js";
import { type BridgeSide, checkBridgeLimit, checkBridgePair } from "./pair.js";

// The limit is the one hub read; everything else runs on the real SDK and its packaged config.
vi.mock("../sodax.js", async () => ({
  ...(await vi.importActual<typeof import("../sodax.js")>("../sodax.js")),
  bridgeLimit: vi.fn(),
}));

const sdk = await vi.importActual<typeof import("../sodax.js")>("../sodax.js");
await sdk.initSodax();

const catalog = getBridgeCatalog();
const side = (chain: string, token: string, which: "from" | "to"): BridgeSide =>
  resolveExactly(catalog, chain, token, `${which}Token`, which);

const ARB_USDC = side("arbitrum", "USDC", "from");
const BASE_USDC = side("base", "USDC", "to");
const BSC_USDC = side("bsc", "USDC", "to");

function failure(check: () => unknown): ActionError {
  try {
    check();
  } catch (error) {
    expect(error).toBeInstanceOf(ActionError);
    return error as ActionError;
  }
  throw new Error("didn't fail");
}

async function asyncFailure(check: () => Promise<unknown>): Promise<ActionError> {
  const error = await check().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
}

describe("checkBridgePair", () => {
  it("passes tokens that share a hub vault, whatever their decimals", () => {
    expect(() => checkBridgePair(catalog, ARB_USDC, BASE_USDC)).not.toThrow();
    expect(() => checkBridgePair(catalog, ARB_USDC, BSC_USDC)).not.toThrow();
  });

  it("refuses a pair without a shared vault, offering what the source does bridge to there", () => {
    const error = failure(() => checkBridgePair(catalog, ARB_USDC, side("base", "native", "to")));
    expect(error.code).toBe("BRIDGE_REJECTED");
    expect(error.details).toEqual({ reason: "not_bridgeable", field: "toToken" });
    expect(error.hint?.options).toEqual([
      { label: "USDC on Base", args: { toChain: "0x2105.base", toToken: BASE_USDC.token.address } },
    ]);
    expect(error.nextStep).toContain("bridges only to USDC on Base");
  });

  it("refuses both sides on one chain", () => {
    const error = failure(() => checkBridgePair(catalog, ARB_USDC, side("arbitrum", "USDC", "to")));
    expect(error.details).toEqual({ reason: "same_chain", field: "toChain" });
  });

  it("refuses a withdraw-only token as the one sent", () => {
    const tbtc = side("arbitrum", "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40", "from");
    const error = failure(() => checkBridgePair(catalog, tbtc, side("base", "cbBTC", "to")));
    expect(error.code).toBe("RESTRICTED_TOKEN");
    expect(error.details).toEqual({ side: "from", field: "fromToken" });
  });
});

describe("checkBridgeLimit", () => {
  beforeEach(() => {
    vi.mocked(bridgeLimit).mockReset();
  });

  const limit = (amount: bigint, decimals: number, type: "DEPOSIT_LIMIT" | "WITHDRAWAL_LIMIT" = "DEPOSIT_LIMIT") =>
    vi.mocked(bridgeLimit).mockResolvedValueOnce({ amount, decimals, type });

  it("asks the hub for this pair and passes an amount up to the limit", async () => {
    limit(5_000_000n, 6);
    await expect(checkBridgeLimit(5_000_000n, ARB_USDC, BASE_USDC)).resolves.toBeUndefined();
    expect(bridgeLimit).toHaveBeenCalledWith(
      { chainKey: "0xa4b1.arbitrum", address: ARB_USDC.token.address },
      { chainKey: "0x2105.base", address: BASE_USDC.token.address },
    );
  });

  it("refuses an amount above the limit, naming the most in the source token's units", async () => {
    limit(4_500_000n, 6);
    const error = await asyncFailure(() => checkBridgeLimit(5_000_000n, ARB_USDC, BASE_USDC));
    expect(error.code).toBe("BRIDGE_REJECTED");
    expect(error.details).toEqual({ reason: "above_limit", field: "amount", maxAmount: "4.5" });
  });

  it("compares across precisions exactly: a limit in 18 decimals against 6", async () => {
    limit(5n * 10n ** 18n, 18, "WITHDRAWAL_LIMIT");
    await expect(checkBridgeLimit(5_000_000n, ARB_USDC, BSC_USDC)).resolves.toBeUndefined();
    limit(5n * 10n ** 18n - 1n, 18, "WITHDRAWAL_LIMIT");
    const error = await asyncFailure(() => checkBridgeLimit(5_000_000n, ARB_USDC, BSC_USDC));
    // Rounded down to what the source can send: 4.999999, never more than the limit.
    expect(error.details).toMatchObject({ maxAmount: "4.999999" });
  });

  it("says the route takes nothing right now when the limit is zero", async () => {
    limit(0n, 6);
    const error = await asyncFailure(() => checkBridgeLimit(1n, ARB_USDC, BASE_USDC));
    expect(error.details).toEqual({ reason: "no_capacity" });
  });

  it("is CHAIN_UNAVAILABLE when the hub can't be read", async () => {
    vi.mocked(bridgeLimit).mockRejectedValueOnce(new Error("SDK call failed"));
    const error = await asyncFailure(() => checkBridgeLimit(1n, ARB_USDC, BASE_USDC));
    expect(error.code).toBe("CHAIN_UNAVAILABLE");
  });
});

describe("bridgeAmounts", () => {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  const chainToken = ({ chain, token }: BridgeSide) => ({ chainKey: chain.key, address: token.address });

  it("delivers the same amount between tokens of equal decimals, and scales between others", () => {
    expect(bridgeAmounts(5_000_000n, chainToken(ARB_USDC), chainToken(BASE_USDC))).toEqual({
      delivered: 5_000_000n,
      fee: 0n,
    });
    expect(bridgeAmounts(5_000_000n, chainToken(ARB_USDC), chainToken(BSC_USDC)).delivered).toBe(5n * 10n ** 18n);
  });

  it("takes the partner fee in vault units, as the SDK's own build encodes it", async () => {
    const partnerFee = { address: `0x${"a".repeat(40)}`, bps: 25 };
    const { delivered, fee } = bridgeAmounts(5_000_000n, chainToken(ARB_USDC), chainToken(BASE_USDC), partnerFee);
    expect(fee).toBe((5n * 10n ** 18n * 25n) / 10_000n);
    expect(delivered).toBe(5_000_000n - (5_000_000n * 25n) / 10_000n);
    // The SDK's own payload for this bridge carries both amounts.
    const { Sodax } = await import("@sodax/sdk");
    const bridge = new Sodax().bridge;
    const token = (side: BridgeSide) => {
      const found = new Sodax().config.getSpokeTokenFromOriginalAssetAddress(
        side.chain.key as never,
        side.token.address,
      );
      if (!found) throw new Error("not in config");
      return found;
    };
    const payload = bridge.buildBridgeData(
      {
        srcChainKey: ARB_USDC.chain.key as never,
        dstChainKey: BASE_USDC.chain.key as never,
        srcToken: ARB_USDC.token.address,
        dstToken: BASE_USDC.token.address,
        amount: 5_000_000n,
        recipient: `0x${"b".repeat(40)}`,
        srcAddress: `0x${"b".repeat(40)}`,
      } as never,
      token(ARB_USDC),
      token(BASE_USDC),
      { address: partnerFee.address as `0x${string}`, percentage: partnerFee.bps },
    );
    expect(payload.toLowerCase()).toContain(word(fee));
    expect(payload.toLowerCase()).toContain(word(delivered));
  });
});
