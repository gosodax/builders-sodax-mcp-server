import { solverConfig } from "@sodax/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { pinnedSourceOf } from "../sodax.js";
import { fixtureCatalog } from "./__fixtures__/catalog.js";
import { toChain } from "./resolver.js";
import { sourceChainFor } from "./source.js";

const ARBITRUM = toChain("0xa4b1.arbitrum");

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

  it("refuses sui, which track can't check a deposit on", () => {
    expect(() => sourceChainFor(fixtureCatalog(), toChain("sui"))).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_SOURCE" }),
    );
  });

  // The swap tx itself creates the intent there: track checks the intents contract's log, no connection.
  it("takes sonic, the hub, with the intents contract and no connection", () => {
    expect(sourceChainFor(fixtureCatalog(), toChain("sonic"))).toEqual({
      chainId: 146,
      swapContract: solverConfig.intentsContract,
    });
  });
});

// The chain support tool says from this whether a swap can start on a chain.
describe("pinnedSourceOf", () => {
  it.each([
    ["sonic", true],
    ["0xa4b1.arbitrum", true],
    ["0x2105.base", true],
    ["sui", false],
    ["solana", false],
    ["atlantis", false],
  ])("%s → %s", (key, startsSwap) => {
    expect(pinnedSourceOf(key) !== undefined).toBe(startsSwap);
  });
});
