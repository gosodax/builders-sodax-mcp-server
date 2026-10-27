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

  it.each(["sonic", "sui"])("refuses %s, which track can't check a deposit on", key => {
    expect(() => sourceChainFor(fixtureCatalog(), toChain(key))).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_SOURCE" }),
    );
  });
});
