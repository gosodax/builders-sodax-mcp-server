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

describe("URL path-segment encoding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function loadApi() {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    return { mod, mockFetchJson: vi.mocked(http.fetchJson), mockFetchJsonOrNull: vi.mocked(http.fetchJsonOrNull) };
  }

  it("keeps a traversal attempt inside a single path segment", async () => {
    const { mod, mockFetchJsonOrNull } = await loadApi();
    mockFetchJsonOrNull.mockResolvedValueOnce(null);

    await mod.getTransaction("../../../../etc/passwd");

    const url = new URL(mockFetchJsonOrNull.mock.calls[0][0] as string);
    expect(url.host).toBe("api.sodax.com");
    expect(url.pathname).toBe("/v1/be/intent/tx/..%2F..%2F..%2F..%2Fetc%2Fpasswd");
    expect(url.pathname.startsWith("/v1/be/")).toBe(true);
  });

  it("rejects a bare '..' segment instead of issuing a traversing request", async () => {
    // %2E is percent-decoded by the URL parser before its double-dot check, so
    // ".." cannot be neutralised by encoding — it has to be refused.
    const { mod, mockFetchJsonOrNull } = await loadApi();

    await expect(mod.getIntent("..")).rejects.toThrow(/Failed to fetch intent/);
    expect(mockFetchJsonOrNull).not.toHaveBeenCalled();
  });

  it("does not let a smuggled query param clobber the intended limit", async () => {
    const { mod, mockFetchJson } = await loadApi();
    mockFetchJson.mockResolvedValueOnce({ items: [] });

    await mod.getUserTransactions("x?admin=1", { limit: 10 });

    const url = new URL(mockFetchJson.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/be/intent/user/x%3Fadmin%3D1");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("admin")).toBeNull();
  });

  it("encodes every interpolated segment of a multi-segment path", async () => {
    const { mod, mockFetchJson } = await loadApi();
    mockFetchJson.mockResolvedValueOnce({});

    await mod.getAmmPoolCandles("../evil", "a/b", { interval: "1h" });

    const url = new URL(mockFetchJson.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/be/amm/pools/..%2Fevil/a%2Fb/candles");
    expect(url.searchParams.get("interval")).toBe("1h");
  });

  it("encodes the partner receiver segment", async () => {
    const { mod, mockFetchJsonOrNull } = await loadApi();
    mockFetchJsonOrNull.mockResolvedValueOnce(null);

    await mod.getPartnerSummary("a/b?x=1");

    const url = new URL(mockFetchJsonOrNull.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/be/partners/a%2Fb%3Fx%3D1/summary");
  });
});

describe("cache keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not collide a literal chainId of 'all' with the unfiltered case", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    const mockFetchJson = vi.mocked(http.fetchJson);
    mockFetchJson.mockResolvedValueOnce([{ symbol: "ONLY_ON_ALL_CHAIN" }]);
    mockFetchJson.mockResolvedValueOnce({ "1": [{ symbol: "ETH" }] });

    const scoped = await mod.getSwapTokens("all");
    const unscoped = await mod.getSwapTokens();

    expect(scoped).toEqual([{ symbol: "ONLY_ON_ALL_CHAIN" }]);
    expect(unscoped).toEqual([{ symbol: "ETH", chainId: "1" }]);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it("does not collide volume token pairs that differ only in delimiter placement", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    const mockFetchJson = vi.mocked(http.fetchJson);
    const first = { items: [{ intentHash: "first" }], hasMore: false };
    const second = { items: [{ intentHash: "second" }], hasMore: false };
    mockFetchJson.mockResolvedValueOnce(first);
    mockFetchJson.mockResolvedValueOnce(second);

    // Under the old `volume-${input}-${output}-...` key these two produced the
    // identical key "volume-A-B-C-...", so the second caller was served the
    // first caller's data.
    const a = await mod.getVolume({ inputToken: "A", outputToken: "B-C" });
    const b = await mod.getVolume({ inputToken: "A-B", outputToken: "C" });

    expect(a).toEqual(first);
    expect(b).toEqual(second);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it("still serves a genuine cache hit for identical volume params", async () => {
    vi.resetModules();
    const mod = await import("./sodaxApi.js");
    const http = await import("./http.js");
    const mockFetchJson = vi.mocked(http.fetchJson);
    mockFetchJson.mockResolvedValueOnce({ items: [], hasMore: false });

    await mod.getVolume({ inputToken: "A", outputToken: "B", limit: 10 });
    await mod.getVolume({ inputToken: "A", outputToken: "B", limit: 10 });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
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
