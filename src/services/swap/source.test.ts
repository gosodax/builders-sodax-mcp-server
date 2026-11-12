import { solverConfig, spokeChainConfig } from "@sodax/types";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { NON_EVM_SOURCE_TYPES, initSodax, pinnedSourceOf } from "../sodax.js";
import { fixtureCatalog } from "./__fixtures__/catalog.js";
import { toChain } from "./resolver.js";
import { sourceChainFor } from "./source.js";

const ARBITRUM = toChain("0xa4b1.arbitrum");

// A non-EVM source needs its asset manager marker, which the SDK encodes.
beforeAll(() => initSodax());

afterEach(() => {
  vi.restoreAllMocks();
});

// Quote, track and cancel all take the source chain from here.
describe("sourceChainFor", () => {
  it("takes an EVM spoke's chain id from the SDK config", () => {
    expect(sourceChainFor(fixtureCatalog(), ARBITRUM)).toMatchObject({ chainId: 42161 });
  });

  it("keeps the SDK config's chain id when the live one differs, which only the quote refuses", () => {
    const catalog = fixtureCatalog();
    catalog.chains[ARBITRUM.key] = { ...catalog.chains[ARBITRUM.key], chainId: 8453 };
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(sourceChainFor(catalog, ARBITRUM)).toMatchObject({ chainId: 42161 });
    expect(error).not.toHaveBeenCalled();
  });

  it("takes sui, a non-EVM spoke, with its asset manager from the SDK config", () => {
    expect(sourceChainFor(fixtureCatalog(), toChain("sui"))).toEqual({
      family: "SUI",
      swapContract: spokeChainConfig.sui.addresses.assetManager,
      // The shared asset manager object, the part of `<package>::asset_manager::<object>` that upgrades keep.
      marker: Uint8Array.from(Buffer.from(spokeChainConfig.sui.addresses.assetManager.split("::")[2].slice(2), "hex")),
    });
  });

  it("refuses ICON, which isn't a source here", () => {
    expect(() => sourceChainFor(fixtureCatalog(), toChain("0x1.icon"))).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_SOURCE",
        // As the live catalog has them: the fixture's.
        details: {
          sourceChains: expect.arrayContaining([
            { key: "sonic", name: "Sonic" },
            { key: "0xa4b1.arbitrum", name: "Arbitrum" },
            { key: "sui", name: "Sui" },
          ]),
        },
      }),
    );
  });

  // The swap tx itself creates the intent there: track checks the intents contract's log, no connection.
  it("takes sonic, the hub, with the intents contract and no connection", () => {
    expect(sourceChainFor(fixtureCatalog(), toChain("sonic"))).toEqual({
      family: "EVM",
      chainId: 146,
      swapContract: solverConfig.intentsContract,
    });
  });
});

// The chain support tool says from this whether a swap can start on a chain.
describe("pinnedSourceOf", () => {
  // Each non-EVM family's tx reader uses the SDK's one service for it: a second chain of a family would be read on
  // the first one's, so it isn't a source until its reader learns to pick (and this test says so).
  it.each(NON_EVM_SOURCE_TYPES)("finds one %s chain in the SDK config, which a swap can start from", type => {
    const chains = Object.entries(spokeChainConfig).filter(([, config]) => config.chain.type === type);
    expect(chains).toHaveLength(1);
    // With the marker track proves its deposits by: a chain without one is never a source.
    expect(pinnedSourceOf(chains[0][0])).toMatchObject({ family: type, marker: expect.anything() });
  });

  it.each([
    ["sonic", true],
    ["0xa4b1.arbitrum", true],
    ["0x2105.base", true],
    ["sui", true],
    ["solana", true],
    ["near", true],
    ["stellar", true],
    ["injective-1", true],
    ["bitcoin", false],
    ["stacks", false],
    ["0x1.icon", false],
    ["atlantis", false],
  ])("%s → %s", (key, startsSwap) => {
    expect(pinnedSourceOf(key) !== undefined).toBe(startsSwap);
  });
});
