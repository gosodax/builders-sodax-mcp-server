import { spokeChainConfig } from "@sodax/types";
import { beforeAll, describe, expect, it } from "vitest";
import { initSodax } from "../sodax.js";
import { resolveExactly } from "../swap/resolver.js";
import { findToken, nativeToken } from "../swap/tokens.js";
import { getBridgeCatalog } from "./catalog.js";

// The resolver judges a query against the chain's own address format, which the SDK knows.
beforeAll(() => initSodax());

const catalog = getBridgeCatalog();
const listed = (chainKey: string, address: string) => findToken(catalog, chainKey, address) !== undefined;

describe("bridge catalog", () => {
  it("lists every chain of the SDK's packaged config, with its family", () => {
    expect(Object.keys(catalog.tokens).sort()).toEqual(Object.keys(spokeChainConfig).sort());
    expect(catalog.chains.solana?.type).toBe("SOLANA");
    expect(catalog.chains["0xa4b1.arbitrum"]).toMatchObject({ type: "EVM", chainId: 42161 });
  });

  it("lists bridge tokens the swap list doesn't have", () => {
    // Live on 2026-11-25: on /v1/bridge/tokens, not on /v1/swaps/tokens.
    expect(resolveExactly(catalog, "base", "USDT", "token").token.address.toLowerCase()).toBe(
      "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
    );
    expect(resolveExactly(catalog, "polygon", "USDT", "token").token.symbol).toBe("USDT");
    expect(resolveExactly(catalog, "arbitrum", "USDS", "token").token.symbol).toBe("USDS");
  });

  it("leaves out the leverage-yield share tokens, as bridge-api does", () => {
    expect(listed("sonic", "0xD09de2f5070699A909c0FD32fb5A909d3886701D")).toBe(false); // lsodaWEETH
    expect(listed("sonic", "0x758532F160D9D338bf662A4a59BA31a5B918A7cb")).toBe(false); // lsodaSUSDS
  });

  it("leaves out tokens without a hub asset or vault", () => {
    const afSui = Object.values(spokeChainConfig.sui.supportedTokens).find(token => token.symbol === "afSUI");
    expect(afSui && listed("sui", afSui.address)).toBe(false);
  });

  it("keeps each token's direction and marks the native token", () => {
    expect(findToken(catalog, "0x2105.base", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf")?.access).toBe(
      "withdrawOnly",
    );
    expect(nativeToken(catalog, "0x2105.base")?.symbol).toBe("ETH");
  });
});
