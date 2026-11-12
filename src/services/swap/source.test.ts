import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
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

  // With no live chain config, there's no list to name; a sent swap still isn't told to swap again.
  it.each([
    [false, "A swap can't start from that chain yet: ask the user to swap from another one."],
    [true, "No swap can start from Sonic: ask the user which chain they sent the swap from and pass its key."],
  ])("refuses with no source to name (sent: %s)", (sent, nextStep) => {
    const catalog = { ...fixtureCatalog(), chains: {} };
    expect(() => sourceChainFor(catalog, toChain("sonic"), sent)).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_SOURCE", nextStep, details: undefined }),
    );
  });

  it.each(["sonic", "sui"])("refuses %s, which track can't check a deposit on", key => {
    expect(() => sourceChainFor(fixtureCatalog(), toChain(key))).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_SOURCE" }),
    );
  });
});
