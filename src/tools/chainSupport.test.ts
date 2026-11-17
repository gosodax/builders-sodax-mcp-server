import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../services/sodaxApi.js";
import { catalogFetch, fixtureText } from "../services/swap/__fixtures__/catalog.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { swapSourceSupport } from "./sodaxApi.js";

const ARBITRUM = "0xa4b1.arbitrum";

beforeEach(() => {
  clearSwapCatalogCache();
  clearCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("sodax_check_chain_support on starting a swap", () => {
  it("says a swap can start from the hub and from an EVM spoke the quote takes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch());
    expect(await swapSourceSupport("sonic")).toContain("can start a swap from it");
    expect(await swapSourceSupport(ARBITRUM)).toContain("can start a swap from it");
    expect(await swapSourceSupport("sui")).toContain("can't start a swap from it yet");
  });

  it("asks the live catalog, as the quote does, not only the SDK's packaged config", async () => {
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    delete configs[ARBITRUM];
    vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch(undefined, JSON.stringify(configs)));
    expect(await swapSourceSupport(ARBITRUM)).toContain("can't start a swap from it yet");
  });

  it("says it couldn't check, rather than guess, when the catalog can't be read", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await swapSourceSupport(ARBITRUM)).toContain("couldn't check right now");
  });

  it("says the swap tools are off under the kill switch, without reading the catalog", async () => {
    vi.stubEnv("SODAX_SWAP_TOOLS_ENABLED", "false");
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await swapSourceSupport(ARBITRUM)).toBe("This server's swap tools are turned off.");
    expect(fetch).not.toHaveBeenCalled();
  });
});
