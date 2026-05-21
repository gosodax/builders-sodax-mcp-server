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
