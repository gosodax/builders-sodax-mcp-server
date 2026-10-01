import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http.js", () => ({
  fetchJson: vi.fn(),
  fetchJsonOrNull: vi.fn(),
}));

// The module under test caches by chainId in module-private state. Reset
// modules between tests so each test sees a fresh cache + fresh mock.
async function loadFreshModule() {
  vi.resetModules();
  const mod = await import("./sodaxApi.js");
  const http = await import("./http.js");
  return {
    getSwapTokens: mod.getSwapTokens,
    mockFetchJson: vi.mocked(http.fetchJson),
  };
}

describe("getSwapTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a single-chain array through unchanged", async () => {
    const { getSwapTokens, mockFetchJson } = await loadFreshModule();
    const tokens = [{ symbol: "ETH" }, { symbol: "USDC" }];
    mockFetchJson.mockResolvedValueOnce(tokens);

    const result = await getSwapTokens("1");

    expect(result).toEqual(tokens);
    expect(mockFetchJson).toHaveBeenCalledWith(expect.stringContaining("/config/swap/1/tokens"));
  });

  it("flattens a multi-chain object and attaches the chainId from the wrapping key", async () => {
    const { getSwapTokens, mockFetchJson } = await loadFreshModule();
    mockFetchJson.mockResolvedValueOnce({
      "1": [{ symbol: "ETH" }],
      "42161": [{ symbol: "ARB-USDC" }, { symbol: "ARB-ETH" }],
    });

    const result = await getSwapTokens();

    expect(result).toEqual([
      { symbol: "ETH", chainId: "1" },
      { symbol: "ARB-USDC", chainId: "42161" },
      { symbol: "ARB-ETH", chainId: "42161" },
    ]);
    expect(mockFetchJson).toHaveBeenCalledWith(expect.stringContaining("/config/swap/tokens"));
  });

  it("returns [] when payload is a bare array and no chainId was supplied", async () => {
    // No chainId → the first branch is false (no chainId), the second is
    // false (data IS an array). Both fall through and we return [].
    const { getSwapTokens, mockFetchJson } = await loadFreshModule();
    mockFetchJson.mockResolvedValueOnce([{ symbol: "stray" }]);

    const result = await getSwapTokens();

    expect(result).toEqual([]);
  });

  it("treats every array-valued key as a chainId, including a 'data' wrapper key", async () => {
    // Pins the post-PR-#30 behavior: the chain-keyed loop iterates *all*
    // object keys, so a `{ data: [...] }` wrapper shape is flattened with
    // chainId="data" rather than unwrapped. The trailing `dataObj.data`
    // fallback only fires when the loop produced zero tokens — but if the
    // shape really is `{ data: [...] }` with `data` being an array, the
    // loop already pushed those entries with chainId="data". So the
    // fallback is effectively unreachable in practice; this test documents
    // that, deliberately diverging from the axios version's unconditional
    // `tokens = data?.data || []` fallback. We're keeping the new behavior
    // because reverting would mask "no tokens for any chain" responses on
    // a healthy `{ chain: [] }` shape.
    const { getSwapTokens, mockFetchJson } = await loadFreshModule();
    mockFetchJson.mockResolvedValueOnce({
      data: [{ symbol: "FALLBACK" }],
    });

    const result = await getSwapTokens();

    expect(result).toEqual([{ symbol: "FALLBACK", chainId: "data" }]);
  });
});

describe("getVolumeStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches /solver/volume/stats and returns the filledCount payload", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    const mockFetchJson = vi.mocked(http.fetchJson);
    mockFetchJson.mockResolvedValueOnce({ filledCount: 12345 });

    const result = await mod.getVolumeStats();

    expect(result).toEqual({ filledCount: 12345 });
    expect(mockFetchJson).toHaveBeenCalledWith(expect.stringContaining("/solver/volume/stats"));
  });

  it("serves a cached value on the second call without re-fetching", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    const mockFetchJson = vi.mocked(http.fetchJson);
    mockFetchJson.mockResolvedValueOnce({ filledCount: 7 });

    await mod.getVolumeStats();
    const second = await mod.getVolumeStats();

    expect(second).toEqual({ filledCount: 7 });
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });
});

describe("resolveChainKey", () => {
  const live = ["sonic", "0x2105.base", "0xa4b1.arbitrum", "hedera", "0x1.icon", "robinhood"];

  it("matches an exact chain key", async () => {
    const { resolveChainKey } = await import("./sodaxApi.js");
    expect(resolveChainKey("hedera", live)).toEqual({ key: "hedera", matchedAs: "hedera" });
  });

  it("resolves a ticker/alias case-insensitively (HBAR → hedera)", async () => {
    const { resolveChainKey } = await import("./sodaxApi.js");
    expect(resolveChainKey("HBAR", live)).toEqual({ key: "hedera", matchedAs: "hbar" });
  });

  it("resolves the human suffix of a dotted key (arbitrum → 0xa4b1.arbitrum)", async () => {
    const { resolveChainKey } = await import("./sodaxApi.js");
    expect(resolveChainKey("Arbitrum", live)).toEqual({ key: "0xa4b1.arbitrum", matchedAs: "arbitrum" });
  });

  it("resolves every CHAINS entry by its display name", async () => {
    const { resolveChainKey } = await import("./sodaxApi.js");
    const { CHAINS } = await import("../constants.js");
    const allKeys = Object.keys(CHAINS);
    for (const [key, { name }] of Object.entries(CHAINS)) {
      expect(resolveChainKey(name, allKeys).key, name).toBe(key);
    }
  });

  it("resolves a display name that differs from the key suffix (Avalanche → 0xa86a.avax)", async () => {
    const { resolveChainKey } = await import("./sodaxApi.js");
    expect(resolveChainKey("Avalanche", ["0xa86a.avax", "sonic"]).key).toBe("0xa86a.avax");
  });

  it.each([
    ["Avalanche C-Chain", "0xa86a.avax"],
    ["Robinhood Chain", "robinhood"],
    ["BNB Smart Chain", "0x38.bsc"],
    ["Polygon PoS", "0x89.polygon"],
    ["Hedera Hashgraph", "hedera"],
    ["Hyper EVM", "hyper"],
    ["Base mainnet", "0x2105.base"],
  ])("drops a trailing qualifier (%s → %s)", async (query, expected) => {
    const { resolveChainKey } = await import("./sodaxApi.js");
    const live = ["0xa86a.avax", "robinhood", "0x38.bsc", "0x89.polygon", "hedera", "hyper", "0x2105.base"];
    expect(resolveChainKey(query, live).key).toBe(expected);
  });

  it("returns null for an unknown chain", async () => {
    const { resolveChainKey } = await import("./sodaxApi.js");
    expect(resolveChainKey("dogechain", live)).toEqual({ key: null, matchedAs: null });
  });
});

describe("resolveChainSupport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports supported:true against the live registry (Hedera)", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    vi.mocked(http.fetchJson).mockResolvedValueOnce(["sonic", "hedera", "0x2105.base"]);

    const result = await mod.resolveChainSupport("Hedera");

    expect(result.supported).toBe(true);
    expect(result.chainKey).toBe("hedera");
  });

  it("reports supported:false (and no key) when an alias names a chain not in the live set", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    // hbar aliases hedera, but the live registry does NOT include it here
    vi.mocked(http.fetchJson).mockResolvedValueOnce(["sonic", "ethereum"]);

    const result = await mod.resolveChainSupport("HBAR");

    expect(result.supported).toBe(false);
    // never assert a key the live registry didn't confirm
    expect(result.chainKey).toBeNull();
  });

  it("resolves an alias to the live key spelling even if the live key is reformatted", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    // Live registry moved hedera to an EVM-style key; alias map still says "hedera"
    vi.mocked(http.fetchJson).mockResolvedValueOnce(["sonic", "0x128.hedera"]);

    const result = await mod.resolveChainSupport("HBAR");

    expect(result.supported).toBe(true);
    expect(result.chainKey).toBe("0x128.hedera");
    expect(result.displayName).toBe("Hedera");
  });

  it("excludes wound-down ICON from support and the count", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    vi.mocked(http.fetchJson).mockResolvedValueOnce(["sonic", "hedera", "0x1.icon"]);

    const result = await mod.resolveChainSupport("icon");

    expect(result.supported).toBe(false);
    expect(result.supportedChains).not.toContain("0x1.icon");
    expect(result.supportedChains).toHaveLength(2);
  });
});
