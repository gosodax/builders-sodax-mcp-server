import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "./__fixtures__/catalog.js";
import { type Resolution, resolveToken } from "./resolver.js";
import { parseCatalog } from "./tokens.js";

const catalog = fixtureCatalog();
const resolve = (chain: string, query: string) => resolveToken(catalog, chain, query);

function symbols(result: Resolution): string[] {
  if (result.status === "resolved") return [result.token.symbol];
  return (result.status === "ambiguous" ? result.candidates : result.suggestions).map(token => token.symbol);
}

describe("resolveToken", () => {
  it.each([
    ["sonic", "WETH", "resolved", ["WETH"]],
    ["sonic", "sodaETH", "resolved", ["sodaETH"]],
    ["sonic", "usdc", "resolved", ["USDC"]],
    ["sonic", "sodausdc", "resolved", ["sodaUSDC"]],
    ["sonic", "native", "resolved", ["S"]],
    ["hyper", "USDC", "resolved", ["USDC"]],
    ["hyper", "USDT", "ambiguous", ["USDT0"]],
    ["hyper", "USDT0", "resolved", ["USDT0"]],
    ["ICON", "bnUSD", "ambiguous", ["bnUSD (legacy)"]],
    ["icx", "bnUSD (legacy)", "resolved", ["bnUSD (legacy)"]],
    ["ICON", "native", "resolved", ["ICX"]],
    ["ICON", "cx88fd7df7ddff82f7cc735c871dc519838cb235bb", "resolved", ["bnUSD (legacy)"]],
    ["Arbitrum", "native", "resolved", ["ETH"]],
    ["arb", "eth", "resolved", ["ETH"]],
    ["Avalanche", "WETH", "ambiguous", ["WETH.e"]],
  ])("%s / %s → %s %j", (chain, query, status, expected) => {
    const result = resolve(chain, query);
    expect(result.status).toBe(status);
    expect(symbols(result)).toEqual(expected);
  });

  it("keeps decimals per chain (Sonic USDC 6, sodaUSDC 18)", () => {
    expect(resolve("sonic", "USDC")).toMatchObject({ token: { decimals: 6 } });
    expect(resolve("sonic", "sodaUSDC")).toMatchObject({ token: { decimals: 18 } });
  });

  it('treats "ETH" on Sonic as ambiguous, and Tether USD is not a candidate', () => {
    const result = resolve("sonic", "ETH");
    expect(result.status).toBe("ambiguous");
    expect(symbols(result)).toEqual(expect.arrayContaining(["WETH", "sodaETH"]));
    expect(symbols(result)).not.toContain("USDT");
  });

  it("offers the native token first for a wrapped-native guess (WETH on Arbitrum)", () => {
    const result = resolve("Arbitrum", "WETH");
    expect(result.status).toBe("not_found");
    expect(result.status === "not_found" && result.suggestions[0]).toMatchObject({ symbol: "ETH", isNative: true });
  });

  it("matches an EVM address case-insensitively, and an unknown one finds nothing", () => {
    const byAddress = resolve("Arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(byAddress).toMatchObject({ status: "resolved", matchedBy: "address", token: { symbol: "USDC" } });
    expect(resolve("Arbitrum", `0x${"9".repeat(40)}`)).toMatchObject({ status: "not_found", suggestions: [] });
  });

  it("passes a token's access restriction and RWA flag through", () => {
    expect(resolve("Arbitrum", "tBTC")).toMatchObject({ status: "resolved", token: { access: "withdrawOnly" } });
    expect(resolve("sonic", "SPCX")).toMatchObject({ status: "resolved", token: { isRwa: true } });
  });

  it.each([
    ["sui", "0x2::sui::SUI", "SUI"],
    ["ICON", "CX88FD7DF7DDFF82F7CC735C871DC519838CB235BB", "bnUSD (legacy)"],
  ])("matches a differently spelled address on %s (%s)", (chain, address, symbol) => {
    expect(resolve(chain, address)).toMatchObject({ status: "resolved", matchedBy: "address", token: { symbol } });
  });

  it.each([
    ["sonic", "USD Coin", "USDC"],
    ["sonic", "Wrapped Ether", "WETH"],
    ["sonic", "Space Exploration Technologies Corp", "SPCX"],
  ])("matches a token by name words on %s (%s)", (chain, query, symbol) => {
    const result = resolve(chain, query);
    expect(result.status).toBe("ambiguous");
    expect(symbols(result)).toContain(symbol);
  });

  it("matches an Injective peggy denom whatever its case", () => {
    const token = {
      ...catalog.tokens.hyper[0],
      chainKey: "injective-1",
      address: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7",
    };
    const injective = parseCatalog({ "injective-1": [token] }, {});
    expect(resolveToken(injective, "injective-1", "peggy0xdac17f958d2ee523a2206206994597c13d831ec7")).toMatchObject({
      status: "resolved",
      matchedBy: "address",
    });
  });

  // NEAR's USDC is a 64-hex account: it must match before a 64-hex query is refused as a possible key.
  it("resolves a NEAR token given by its 64-hex address", () => {
    const address = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const near = parseCatalog({ near: [{ ...catalog.tokens.hyper[0], chainKey: "near", address }] }, {});
    expect(resolveToken(near, "near", address)).toMatchObject({ status: "resolved", matchedBy: "address" });
    expect(() => resolveToken(near, "near", "ab".repeat(32))).toThrow(
      expect.objectContaining({ code: "SECRET_REJECTED" }),
    );
  });

  it("reports a chain whose tokens all failed validation as unavailable, not as unknown tokens", () => {
    const broken = parseCatalog({ hyper: [{ symbol: "bad\n" }] }, {});
    expect(() => resolveToken(broken, "hyper", "HYPE")).toThrow(
      expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
    );
  });

  it.each(["arb", "Arbitrum One", "ARBITRUM", "42161", "0xa4b1", "0xA4B1"])("resolves the chain %j", chain => {
    expect(resolve(chain, "USDC").chain.key).toBe("0xa4b1.arbitrum");
  });

  it.each([
    ["146", "sonic"],
    ["0x3e7", "hyper"],
  ])("resolves the EVM chain id %j from the chain config, not the key", (chain, key) => {
    expect(resolve(chain, "USDC").chain.key).toBe(key);
  });

  it("matches a chain id only against EVM chains", () => {
    const usdc = catalog.tokens["0xa4b1.arbitrum"].find(token => token.symbol === "USDC");
    const tokens = { stellar: [{ ...usdc, chainKey: "stellar" }], "0xa4b1.arbitrum": [usdc] };
    const configs = {
      stellar: { chain: { type: "STELLAR", chainId: 42161 } },
      "0xa4b1.arbitrum": { chain: { type: "EVM", chainId: 42161 } },
    };
    expect(resolveToken(parseCatalog(tokens, configs), "42161", "USDC").chain.key).toBe("0xa4b1.arbitrum");
  });

  // 250 / 0xfa is Fantom; 1 is Ethereum, absent here, and must not match the "0x1." of ICON's key.
  it.each(["Fantom", "250", "0xfa", "1", "0x1"])("refuses an unknown chain %j with the supported list", chain => {
    expect(() => resolve(chain, "USDC")).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_CHAIN",
        message: "No SODAX swap chain matches that name, key or chain id.",
        details: { supportedChains: expect.arrayContaining([{ key: "hyper", name: "HyperEVM" }]) },
      }),
    );
  });

  it.each([
    ["Arbitrm", [{ key: "0xa4b1.arbitrum", name: "Arbitrum" }]],
    ["avalanch", [{ key: "0xa86a.avax", name: "Avalanche" }]],
    ["hedra", [{ key: "hedera", name: "Hedera" }]],
  ])("suggests the chain a typo %j is nearest to", (chain, didYouMean) => {
    expect(() => resolve(chain, "USDC")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ didYouMean }),
        nextStep: `Ask the user whether they mean ${didYouMean[0].name}, or else which chain in error.supportedChains, and pass its key.`,
      }),
    );
  });

  it("lists only the chains a swap can start from for a swap's source", () => {
    const chainsOf = (sourcesOnly: boolean) => {
      try {
        resolveToken(catalog, "Fantom", "USDC", "fromToken", sourcesOnly);
      } catch (error) {
        return (error as { details: { supportedChains: { key: string }[] } }).details.supportedChains.map(c => c.key);
      }
    };
    expect(chainsOf(true)).toEqual(expect.arrayContaining(["0xa4b1.arbitrum", "0xa86a.avax", "hyper"]));
    expect(chainsOf(true)).not.toEqual(expect.arrayContaining(["sonic"]));
    expect(chainsOf(true)).not.toEqual(expect.arrayContaining(["sui"]));
    expect(chainsOf(false)).toEqual(expect.arrayContaining(["sonic", "sui", "0xa4b1.arbitrum"]));
  });

  it.each(["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"])(
    "resolves the native placeholder %s to an EVM chain's native token",
    placeholder => {
      expect(resolve("Arbitrum", placeholder)).toMatchObject({
        status: "resolved",
        matchedBy: "native",
        token: { symbol: "ETH", isNative: true },
      });
      expect(resolve("sonic", placeholder)).toMatchObject({ status: "resolved", token: { symbol: "S" } });
    },
  );

  it("doesn't take the EVM native placeholder on a chain that isn't EVM", () => {
    expect(resolve("sui", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).toMatchObject({ status: "not_found" });
  });

  it("resolves the same address on each chain to that chain's own token", () => {
    const zero = `0x${"0".repeat(40)}`;
    expect(resolve("sonic", zero)).toMatchObject({ matchedBy: "address", token: { symbol: "S" } });
    expect(resolve("hyper", zero)).toMatchObject({ matchedBy: "address", token: { symbol: "HYPE" } });
    // Live on 2026-10-27: 0x1f22…dd13 is INJ on Sonic and SODA on Optimism.
    const address = "0x1f22279C89B213944b7Ea41daCB0a868DdCDFd13";
    const twins = parseCatalog(
      {
        sonic: [{ ...catalog.tokens.sonic[1], symbol: "INJ", address }],
        "0xa.optimism": [{ ...catalog.tokens.sonic[1], symbol: "SODA", address, chainKey: "0xa.optimism" }],
      },
      {},
    );
    expect(resolveToken(twins, "sonic", address)).toMatchObject({ token: { symbol: "INJ", chainKey: "sonic" } });
    expect(resolveToken(twins, "Optimism", address)).toMatchObject({ token: { symbol: "SODA" } });
  });

  it("names the other chains that list an address this chain doesn't", () => {
    const arbitrumUsdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    expect(resolve("Avalanche", arbitrumUsdc)).toMatchObject({
      status: "not_found",
      otherChains: [{ chain: { key: "0xa4b1.arbitrum", name: "Arbitrum" }, token: { symbol: "USDC" } }],
    });
    expect(resolve("Avalanche", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toMatchObject({ suggestions: [] });
  });

  it("names the other chains that list a symbol this chain doesn't, a native one included", () => {
    expect(resolve("Arbitrum", "hbar")).toMatchObject({
      status: "not_found",
      otherChains: [{ chain: { key: "hedera", name: "Hedera" }, token: { symbol: "HBAR", isNative: true } }],
    });
    const weth = resolve("Arbitrum", "WETH");
    expect(weth).toMatchObject({ otherChains: [{ chain: { key: "sonic" }, token: { symbol: "WETH" } }] });
    expect(symbols(weth)[0]).toBe("ETH");
  });

  it("never names another chain's native token for an address this chain doesn't list", () => {
    const result = resolve("ICON", `0x${"0".repeat(40)}`);
    expect(result.status).toBe("not_found");
    expect(result).not.toHaveProperty("otherChains");
  });

  it("names every other chain that lists the address", () => {
    const address = `0x${"ab".repeat(20)}`;
    const keys = ["sonic", "hyper", "0xa4b1.arbitrum", "0xa86a.avax", "0xa.optimism", "0x38.bsc", "0x2105.base"];
    const token = catalog.tokens.sonic[1];
    const shared = parseCatalog(
      {
        sui: catalog.tokens.sui,
        ...Object.fromEntries(keys.map(chainKey => [chainKey, [{ ...token, address, chainKey }]])),
      },
      {},
    );
    const result = resolveToken(shared, "sui", address);
    expect(result.status === "not_found" && result.otherChains?.map(other => other.chain.key)).toEqual(keys);
  });

  it.each(["USDC\u200B", "\u200BUSDC", "US\u200BDC", "ＵＳＤＣ", "UЅDC"])(
    "never resolves the lookalike %j as an exact match",
    query => {
      expect(resolve("sonic", query).status).not.toBe("resolved");
    },
  );

  it("finds no native token on a chain the config doesn't describe", () => {
    const partial = parseCatalog({ newchain: [{ ...catalog.tokens.hyper[0], chainKey: "newchain" }] }, {});
    expect(resolveToken(partial, "newchain", "native")).toMatchObject({ status: "not_found" });
  });
});

describe("parseCatalog", () => {
  it("drops chains whose key isn't a chain key, __proto__ included", () => {
    const parsed = parseCatalog(JSON.parse('{"__proto__":[],"bad key":[],"hyper":[]}'), {});
    expect(Object.keys(parsed.tokens)).toEqual(["hyper"]);
    expect(Object.getPrototypeOf(parsed.tokens)).toBe(Object.prototype);
  });

  it.each([
    ["a malformed family", { type: "evm\n", chainId: 999 }],
    ["an EVM chain without a numeric id", { type: "EVM", chainId: "hyper" }],
    ["no id", { type: "EVM" }],
  ])("leaves out a chain whose config has %s, keeping its tokens", (_case, chain) => {
    const parsed = parseCatalog({ hyper: [catalog.tokens.hyper[0]] }, { hyper: { chain } });
    expect(parsed.chains).toEqual({});
    expect(parsed.tokens.hyper).toHaveLength(1);
  });

  it("keeps a non-EVM chain's string id", () => {
    const parsed = parseCatalog({ sui: [] }, { sui: { chain: { type: "SUI", chainId: "sui" } } });
    expect(parsed.chains).toEqual({ sui: { type: "SUI", chainId: "sui" } });
  });

  it("drops entries that don't look like a token and keeps real names with symbols like •", () => {
    const arbitrum = catalog.tokens["0xa4b1.arbitrum"];
    expect(arbitrum).toHaveLength(20);
    expect(arbitrum.some(token => token.symbol.includes("\n"))).toBe(false);
    expect(catalog.tokens.sonic.some(token => token.name.includes("•"))).toBe(true);
  });
});
