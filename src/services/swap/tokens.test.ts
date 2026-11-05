import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { runWithRequestContext } from "../requestContext.js";
import { clearCache } from "../sodaxApi.js";
import { catalogFetch, fixtureText } from "./__fixtures__/catalog.js";
import { clearSwapCatalogCache, expireSwapCatalog, getSwapCatalog } from "./tokens.js";

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

const isConfigCall = (input: unknown) => String(input).endsWith("/v1/be/config/spoke/all-chains-configs");

beforeEach(() => {
  clearSwapCatalogCache();
  clearCache();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSwapCatalog", () => {
  it("fetches both lists once for concurrent callers and marks native tokens", async () => {
    const [first, second] = await Promise.all([getSwapCatalog(), getSwapCatalog()]);
    expect(first).toBe(second);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(first.tokens.hyper.filter(token => token.isNative).map(token => token.symbol)).toEqual(["HYPE"]);
    expect(first.chains["0xa4b1.arbitrum"]).toEqual({
      type: "EVM",
      chainId: 42161,
      swapContract: "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3",
    });
    // Sonic is the hub: no asset manager, so no swap contract from this config.
    expect(first.chains.sonic).toEqual({ type: "EVM", chainId: 146 });
    expect(first.chains.sui).toEqual({ type: "SUI", chainId: "sui" });
  });

  it("sends the caller's key on the Swaps API call", async () => {
    await runWithRequestContext({ apiKey: "sodax_k1" }, () => getSwapCatalog());
    const tokensCall = fetchSpy.mock.calls.find(([input]) => String(input).endsWith("/v1/swaps/tokens"));
    expect((tokensCall?.[1] as RequestInit).headers).toMatchObject({ "x-api-key": "sodax_k1" });
  });

  it.each([
    ["the API fails", () => fetchSpy.mockRejectedValue(new Error("offline"))],
    ["no token passes validation", () => fetchSpy.mockImplementation(catalogFetch('{"sonic":[{"symbol":"bad\\n"}]}'))],
  ])("reports UPSTREAM_UNAVAILABLE when %s", async (_case, setUp) => {
    setUp();
    await expect(getSwapCatalog()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it.each([
    ["the chain config is down", () => Promise.reject(new Error("config down"))],
    ["the chain config marks no native token", async () => new Response("{}")],
  ])("never caches a catalog without native marks: %s", async (_case, config) => {
    const serve = catalogFetch();
    fetchSpy.mockImplementation(async (input, init) => (isConfigCall(input) ? config() : serve(input, init)));
    await expect(getSwapCatalog()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("serves a catalog where some chains have no native mark, and names them in a warning", async () => {
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    delete configs.hyper.nativeToken;
    configs.sui.nativeToken = "0x2::sui::NOT_SUI";
    const serve = catalogFetch();
    fetchSpy.mockImplementation(async (input, init) =>
      isConfigCall(input) ? new Response(JSON.stringify(configs)) : serve(input, init),
    );
    const warn = vi.spyOn(logger, "warn");
    const catalog = await getSwapCatalog();
    expect(catalog.tokens.hyper.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith({ chains: ["hyper", "sui"] }, "No native token is marked on these swap chains");
  });

  it("names the chains whose config is missing or malformed in a warning", async () => {
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    configs.hyper.chain.chainId = "hyper";
    delete configs.sui.chain;
    const serve = catalogFetch();
    fetchSpy.mockImplementation(async (input, init) =>
      isConfigCall(input) ? new Response(JSON.stringify(configs)) : serve(input, init),
    );
    const warn = vi.spyOn(logger, "warn");
    const catalog = await getSwapCatalog();
    expect(catalog.chains).not.toHaveProperty("hyper");
    expect(warn).toHaveBeenCalledWith({ chains: ["hyper", "sui"] }, "No valid chain config for these swap chains");
  });

  it("still serves a catalog whose config names no asset manager, and logs it", async () => {
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    for (const config of Object.values<{ addresses?: unknown }>(configs)) delete config.addresses;
    fetchSpy.mockImplementation(catalogFetch(undefined, JSON.stringify(configs)));
    const error = vi.spyOn(logger, "error");
    const catalog = await getSwapCatalog();
    expect(catalog.tokens.hyper.length).toBeGreaterThan(0);
    expect(error).toHaveBeenCalledWith("No EVM chain config names an asset manager");
  });

  it("serves the last catalog at once while a refresh fails, for up to 30 minutes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const fresh = await getSwapCatalog();
    fetchSpy.mockImplementation(() => new Promise(() => undefined)); // upstream hangs

    now.mockReturnValue(5 * 60_000);
    expect(await getSwapCatalog()).toBe(fresh);
  });

  it("keeps the last catalog when a background refresh fails, and waits before asking again", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const fresh = await getSwapCatalog();
    clearCache();
    fetchSpy.mockClear();
    fetchSpy.mockRejectedValue(new Error("offline"));

    now.mockReturnValue(5 * 60_000);
    expect(await getSwapCatalog()).toBe(fresh);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0)); // let the failed refresh settle
    const callsAfterFailure = fetchSpy.mock.calls.length;

    now.mockReturnValue(5 * 60_000 + 10_000);
    expect(await getSwapCatalog()).toBe(fresh);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFailure);
  });

  it("replaces the stale catalog once a background refresh succeeds", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const first = await getSwapCatalog();
    clearCache();
    now.mockReturnValue(5 * 60_000);
    expect(await getSwapCatalog()).toBe(first);
    await vi.waitFor(async () => expect(await getSwapCatalog()).not.toBe(first));
  });

  it("refreshes on the next call after expireSwapCatalog, serving the old catalog meanwhile", async () => {
    const first = await getSwapCatalog();
    clearCache();
    fetchSpy.mockClear();
    expireSwapCatalog();
    expect(await getSwapCatalog()).toBe(first);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });

  it("stops serving a catalog older than 30 minutes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    await getSwapCatalog();
    clearCache();
    fetchSpy.mockRejectedValue(new Error("offline"));
    now.mockReturnValue(31 * 60_000);
    await expect(getSwapCatalog()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("doesn't let a load that started before a clear fill the cache", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    const serve = catalogFetch();
    fetchSpy.mockImplementation(async (input, init) => {
      await gate;
      return serve(input, init);
    });
    const pending = getSwapCatalog();
    clearSwapCatalogCache();
    open();
    await pending;

    fetchSpy.mockClear();
    fetchSpy.mockImplementation(catalogFetch());
    await getSwapCatalog();
    expect(fetchSpy).toHaveBeenCalled();
  });
});
