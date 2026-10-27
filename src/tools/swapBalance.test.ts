import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import { recipientReady, walletBalance } from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { catalogFetch, fixtureText } from "../services/swap/__fixtures__/catalog.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { callTool } from "./__fixtures__/swapClient.js";

// Unit tests don't reach a chain: balances are scripted per test, by token address.
vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return { ...actual, walletBalance: vi.fn(), recipientReady: vi.fn() };
});

const USER = "0x000000000000000000000000000000000000dEaD";
const ARB_ETH = "0x0000000000000000000000000000000000000000";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const STELLAR_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const STELLAR_USER = "GDYUTHY75A7WUZJQDPOP66FB32BOYGZRXHWTWO4Q6LQTANT5X3V5HNFA";
const balance = (args: Record<string, unknown>) => callTool("sodax_get_balance", args);
const holding = (balances: Record<string, bigint | null>) =>
  vi
    .mocked(walletBalance)
    .mockImplementation(async (_chain, _address, token) => (token.address in balances ? balances[token.address] : 0n));

/** The recorded catalog plus Stellar, with XLM and USDC as the live list has them. */
function withStellar() {
  const tokens = JSON.parse(fixtureText("swap-tokens.json"));
  const configs = JSON.parse(fixtureText("chain-configs.json"));
  const token = { decimals: 7, chainKey: "stellar", hubAsset: ARB_USDC };
  tokens.stellar = [
    { ...token, symbol: "XLM", name: "Stellar Lumens", address: XLM },
    { ...token, symbol: "USDC", name: "USD Coin", address: STELLAR_USDC },
  ];
  configs.stellar = {
    chain: { id: "stellar", chainId: "stellar", name: "Stellar", type: "STELLAR" },
    nativeToken: XLM,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch(JSON.stringify(tokens), JSON.stringify(configs)));
}

beforeEach(() => {
  clearSwapCatalogCache();
  clearCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(walletBalance).mockReset();
  vi.mocked(recipientReady).mockReset();
});

describe("sodax_get_balance", () => {
  it.each([
    [
      "the native coin",
      { chain: "arb" },
      { [ARB_ETH]: 15n * 10n ** 14n },
      "The wallet's balance on Arbitrum: 0.0015 ETH.",
    ],
    [
      "a token next to it",
      { chain: "Arbitrum", token: "USDC" },
      { [ARB_ETH]: 10n ** 18n, [ARB_USDC]: 12_340_000n },
      "The wallet's balance on Arbitrum: 1 ETH and 12.34 USDC.",
    ],
    [
      "a wallet without gas",
      { chain: "arb", token: ARB_USDC },
      { [ARB_USDC]: 5_000_000n },
      "The wallet's balance on Arbitrum: 0 ETH and 5 USDC. With no ETH it likely can't pay gas there.",
    ],
  ])("reads %s", async (_case, args, balances, nextStep) => {
    holding(balances);
    const { out } = await balance({ address: USER, ...args });
    expect(out).toMatchObject({ status: "ok", chain: { key: "0xa4b1.arbitrum", name: "Arbitrum" } });
    expect(out.nextStep).toBe(nextStep);
  });

  it("returns token units and base units, both at once", async () => {
    holding({ [ARB_ETH]: 10n ** 18n, [ARB_USDC]: 12_340_000n });
    const { out } = await balance({ chain: "arb", address: USER, token: "USDC" });
    expect(out).toMatchObject({
      native: { symbol: "ETH", amount: "1", baseUnits: "1000000000000000000" },
      token: { symbol: "USDC", amount: "12.34", baseUnits: "12340000" },
    });
    expect(walletBalance).toHaveBeenCalledTimes(2);
  });

  it("reads the native coin once, and returns no token, when it's the token asked for", async () => {
    holding({ [ARB_ETH]: 10n ** 18n });
    const { out } = await balance({ chain: "arb", address: USER, token: "native" });
    expect(out.native).toMatchObject({ symbol: "ETH", amount: "1" });
    expect(out.token).toBeUndefined();
    expect(walletBalance).toHaveBeenCalledTimes(1);
  });

  it("keeps the chain's decimals as the SDK returns them (Hedera native has 8)", async () => {
    vi.mocked(walletBalance).mockResolvedValue(123_456_789n);
    const { out } = await balance({ chain: "hedera", address: USER });
    expect(out.native).toMatchObject({ symbol: "HBAR", amount: "1.23456789", baseUnits: "123456789" });
  });

  it.each([
    ["a bad address", { chain: "arb", address: "0x1234" }, "INVALID_ADDRESS"],
    ["the zero address", { chain: "arb", address: `0x${"0".repeat(40)}` }, "INVALID_ADDRESS"],
    ["something that isn't an address on Sui", { chain: "sui", address: "not an address" }, "INVALID_ADDRESS"],
    ["an ambiguous token", { chain: "arb", address: USER, token: "USD" }, "UNKNOWN_TOKEN"],
    ["an unknown chain", { chain: "not-a-chain", address: USER }, "UNSUPPORTED_CHAIN"],
  ])("refuses %s before reading the chain", async (_case, args, code) => {
    const { isError, out } = await balance(args);
    expect(isError).toBe(true);
    expect(out.error.code).toBe(code);
    expect(walletBalance).not.toHaveBeenCalled();
  });

  it("says an account that doesn't exist yet holds nothing, even when its token read fails", async () => {
    withStellar();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.mocked(walletBalance).mockImplementation(async (_chain, _address, token) => {
      if (token.address === XLM) return null;
      throw new Error("account not found");
    });
    const { isError, out } = await balance({ chain: "stellar", address: STELLAR_USER, token: "USDC" });
    expect(isError).toBeFalsy();
    expect(out).toMatchObject({ accountExists: false, native: { baseUnits: "0" }, token: { baseUnits: "0" } });
    expect(out.nextStep).toBe(
      "The wallet has no account on Stellar yet, so it holds nothing there; it needs XLM sent to it first.",
    );
    expect(recipientReady).not.toHaveBeenCalled();
  });

  it.each([
    ["fails", () => Promise.reject(new Error("rpc down"))],
    ["says the account is missing", () => Promise.resolve(null)],
  ])("fails a token read that %s when the account exists", async (_case, tokenRead) => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.mocked(walletBalance).mockImplementation(async (_chain, _address, token) =>
      token.address === ARB_ETH ? 1n : tokenRead(),
    );
    const { out } = await balance({ chain: "arb", address: USER, token: "USDC" });
    expect(out.error.code).toBe("CHAIN_UNAVAILABLE");
    expect(recipientReady).not.toHaveBeenCalled();
  });

  it("reads 0 and trustline false for a Stellar token the account has no trustline for", async () => {
    withStellar();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.mocked(walletBalance).mockImplementation(async (_chain, _address, token) => {
      if (token.address === XLM) return 25_000_000n;
      throw new Error("simulation failed");
    });
    vi.mocked(recipientReady).mockResolvedValue(false);
    const { isError, out } = await balance({ chain: "stellar", address: STELLAR_USER, token: "USDC" });
    expect(isError).toBeFalsy();
    expect(out).toMatchObject({ trustline: false, token: { symbol: "USDC", amount: "0", baseUnits: "0" } });
    expect(recipientReady).toHaveBeenCalledWith("STELLAR", STELLAR_USDC, STELLAR_USER, 0n);
    expect(out.nextStep).toBe(
      "The wallet's balance on Stellar: 2.5 XLM and 0 USDC. It has no USDC trustline; the wallet must add one before it can receive USDC.",
    );
  });

  it("fails a Stellar token read the account has a trustline for, or whose trustline can't be read", async () => {
    withStellar();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.mocked(walletBalance).mockImplementation(async (_chain, _address, token) => {
      if (token.address === XLM) return 1n;
      throw new Error("rpc down");
    });
    vi.mocked(recipientReady).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("horizon down"));
    for (let call = 0; call < 2; call++) {
      const { out } = await balance({ chain: "stellar", address: STELLAR_USER, token: "USDC" });
      expect(out.error.code).toBe("CHAIN_UNAVAILABLE");
      expect(out.trustline).toBeUndefined();
    }
  });

  it("reads only BTC on Bitcoin, where the SDK would report any other token as 0", async () => {
    const tokens = JSON.parse(fixtureText("swap-tokens.json"));
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    const btc = {
      symbol: "BTC",
      name: "Bitcoin",
      decimals: 8,
      address: "0:0",
      chainKey: "bitcoin",
      hubAsset: ARB_USDC,
    };
    tokens.bitcoin = [btc, { ...btc, symbol: "RUNE", name: "A rune", address: "840000:1" }];
    configs.bitcoin = {
      chain: { id: "bitcoin", chainId: "bitcoin", name: "Bitcoin", type: "BITCOIN" },
      nativeToken: "0:0",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch(JSON.stringify(tokens), JSON.stringify(configs)));
    const { out } = await balance({
      chain: "bitcoin",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      token: "RUNE",
    });
    expect(out.error).toMatchObject({ code: "UNKNOWN_TOKEN", message: "Only the BTC balance can be read on Bitcoin." });
    expect(walletBalance).not.toHaveBeenCalled();
  });

  it("reports a token list without the chain's native coin as the service being unavailable", async () => {
    const tokens = JSON.parse(fixtureText("swap-tokens.json"));
    tokens["0xa4b1.arbitrum"] = tokens["0xa4b1.arbitrum"].filter(
      (token: { address: string }) => token.address !== ARB_ETH,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch(JSON.stringify(tokens)));
    const { out } = await balance({ chain: "arb", address: USER });
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(walletBalance).not.toHaveBeenCalled();
  });

  it("reports a failed read as the chain being unavailable, never as 0, and keeps the RPC out", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.mocked(walletBalance).mockRejectedValue(new Error("URL: https://rpc.example/KEY"));
    const { isError, out } = await balance({ chain: "arb", address: USER, token: "USDC" });
    expect(isError).toBe(true);
    expect(out.error.code).toBe("CHAIN_UNAVAILABLE");
    expect(JSON.stringify(out)).not.toContain("KEY");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("KEY");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(USER);
  });
});
