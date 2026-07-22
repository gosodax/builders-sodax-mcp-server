/**
 * SODAX API Service
 *
 * Client for fetching live data from the SODAX API.
 * Provides access to chains, tokens, transactions, volume, and more.
 */

import { CACHE_DURATION_MS, NETWORK_COUNT_EXCLUDED_CHAIN_KEYS, SODAX_API_BASE_URL } from "../constants.js";
import type {
  MoneyMarketAsset,
  OrderbookEntry,
  Partner,
  SwapToken,
  TokenSupply,
  Transaction,
  UserPosition,
  VolumeData,
  VolumeStats,
} from "../types.js";
import { fetchJson, fetchJsonOrNull } from "./http.js";
import { logger } from "./logger.js";

// Cache for API responses
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_DURATION_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

function apiUrl(path: string): string {
  return `${SODAX_API_BASE_URL}${path}`;
}

/**
 * Encode a caller-supplied value for use as a single URL path segment.
 *
 * Without this, values like `../../../../etc/passwd` escape the `/v1/be` base
 * prefix, and values containing `?` smuggle (and clobber) query parameters —
 * e.g. `/intent/user/x?admin=1?limit=10` silently drops the intended `limit`.
 *
 * An empty value, or one that is exactly `.` or `..`, is rejected outright:
 * the WHATWG URL parser percent-decodes `%2E` before its single/double-dot
 * check, so no encoding of those values can survive as a literal segment.
 */
function seg(value: string | number): string {
  const raw = String(value);
  if (raw === "" || /^\.{1,2}$/.test(raw)) {
    throw new Error(`Invalid URL path segment: ${JSON.stringify(raw)}`);
  }
  return encodeURIComponent(raw);
}

/**
 * Build an unambiguous cache key.
 *
 * Parts are JSON-encoded as a tuple so no combination of values can collide:
 * a plain `-` join makes ("A","B-C") and ("A-B","C") the same key, and
 * `chainId ?? "all"` makes a literal chainId of "all" indistinguishable from
 * the unfiltered case. `undefined` serializes to `null`, which is distinct
 * from the string `"all"`.
 */
function cacheKey(prefix: string, ...parts: unknown[]): string {
  return parts.length === 0 ? prefix : `${prefix}:${JSON.stringify(parts)}`;
}

/**
 * Get all supported blockchain networks.
 *
 * The `/config/spoke/chains` endpoint returns an array of chain-key strings
 * (e.g. "0x2105.base", "sonic", "0x1.icon"), NOT chain objects — the return
 * type reflects that so callers can filter on the keys directly.
 */
export async function getSupportedChains(): Promise<string[]> {
  const key = "chains";
  const cached = getCached<string[]>(key);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/spoke/chains"));
    // API returns the array of chain keys directly.
    const chains = Array.isArray(data) ? (data as string[]) : (data as { data?: string[] })?.data || [];
    setCache(key, chains);
    return chains;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch supported chains");
    throw new Error("Failed to fetch supported chains from SODAX API");
  }
}

/**
 * Count of publicly integrated networks, mirroring the frontend's
 * stats.ts fetchIntegratedNetworksCount(): the length of /config/spoke/chains
 * with wound-down chains (ICON) filtered out. Reuses getSupportedChains so it
 * shares the 2-minute cache.
 */
export async function getIntegratedNetworksCount(): Promise<number> {
  const chains = await getSupportedChains();
  return chains.filter(key => !NETWORK_COUNT_EXCLUDED_CHAIN_KEYS.includes(key)).length;
}

/**
 * Get available tokens for swapping on a specific chain
 */
export async function getSwapTokens(chainId?: string): Promise<SwapToken[]> {
  const key = cacheKey("tokens", chainId);
  const cached = getCached<SwapToken[]>(key);
  if (cached) return cached;

  try {
    const endpoint = chainId ? `/config/swap/${seg(chainId)}/tokens` : "/config/swap/tokens";
    const data = await fetchJson<unknown>(apiUrl(endpoint));
    // API returns object keyed by chain ID, flatten if getting all
    let tokens: SwapToken[] = [];
    if (chainId && Array.isArray(data)) {
      tokens = data as SwapToken[];
    } else if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      // Flatten all chain tokens into single array
      const dataObj = data as Record<string, unknown>;
      for (const chain of Object.keys(dataObj)) {
        const chainTokens = dataObj[chain];
        if (Array.isArray(chainTokens)) {
          tokens.push(...chainTokens.map((t: SwapToken) => ({ ...t, chainId: chain })));
        }
      }
      if (tokens.length === 0) {
        tokens = (dataObj.data as SwapToken[]) || [];
      }
    }
    setCache(key, tokens);
    return tokens;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch swap tokens");
    throw new Error("Failed to fetch swap tokens from SODAX API");
  }
}

/**
 * Look up a transaction/intent by hash
 */
export async function getTransaction(txHash: string): Promise<Transaction | null> {
  try {
    const data = await fetchJsonOrNull<{ data?: Transaction } | Transaction>(apiUrl(`/intent/tx/${seg(txHash)}`));
    if (data === null) return null;
    return ((data as { data?: Transaction })?.data || (data as Transaction)) ?? null;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch transaction");
    throw new Error("Failed to fetch transaction from SODAX API");
  }
}

/**
 * Get user's intent/transaction history
 */
export async function getUserTransactions(
  userAddress: string,
  options?: {
    limit?: number;
    offset?: number;
    fromBlock?: number;
    toBlock?: number;
  },
): Promise<Transaction[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.append("limit", options.limit.toString());
    if (options?.offset !== undefined) params.append("offset", options.offset.toString());
    if (options?.fromBlock !== undefined) params.append("fromBlock", options.fromBlock.toString());
    if (options?.toBlock !== undefined) params.append("toBlock", options.toBlock.toString());

    const queryString = params.toString();
    const url = apiUrl(`/intent/user/${seg(userAddress)}${queryString ? `?${queryString}` : ""}`);
    const data = await fetchJson<{ items?: Transaction[]; data?: Transaction[] }>(url);
    // API returns { items, total, offset, limit }
    return data?.items || data?.data || [];
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch user transactions");
    throw new Error("Failed to fetch user transactions from SODAX API");
  }
}

/**
 * Get trading volume data from solver
/**
 * Get solver volume data (filled intents) with filtering and pagination
 * Requires inputToken and outputToken. Don't mix block range with time range filters.
 */
export async function getVolume(options: {
  inputToken: string;
  outputToken: string;
  chainId?: number;
  solver?: string;
  fromBlock?: number;
  toBlock?: number;
  since?: string;
  until?: string;
  fromTs?: number;
  toTs?: number;
  sort?: "asc" | "desc";
  limit?: number;
  includeData?: boolean;
  cursor?: string;
}): Promise<VolumeData> {
  // Build cache key from significant params
  const key = cacheKey(
    "volume",
    options.inputToken,
    options.outputToken,
    options.chainId,
    options.limit,
    options.cursor,
  );
  const cached = getCached<VolumeData>(key);
  if (cached) return cached;

  try {
    const params = new URLSearchParams();
    params.append("inputToken", options.inputToken);
    params.append("outputToken", options.outputToken);
    params.append("includeData", (options.includeData ?? false).toString());
    if (options.chainId) params.append("chainId", options.chainId.toString());
    if (options.solver) params.append("solver", options.solver);
    if (options.fromBlock) params.append("fromBlock", options.fromBlock.toString());
    if (options.toBlock) params.append("toBlock", options.toBlock.toString());
    if (options.since) params.append("since", options.since);
    if (options.until) params.append("until", options.until);
    if (options.fromTs !== undefined) params.append("fromTs", options.fromTs.toString());
    if (options.toTs !== undefined) params.append("toTs", options.toTs.toString());
    if (options.sort) params.append("sort", options.sort);
    if (options.limit) params.append("limit", options.limit.toString());
    if (options.cursor) params.append("cursor", options.cursor);

    const queryString = params.toString();
    const url = apiUrl(`/solver/volume${queryString ? `?${queryString}` : ""}`);
    const volumeData = await fetchJson<VolumeData>(url);
    setCache(key, volumeData);
    return volumeData;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch volume");
    throw new Error("Failed to fetch volume data from SODAX API");
  }
}

/**
 * Get aggregate solver volume stats (approximate filled-intent record count).
 * Backed by a collection-metadata read upstream and cached 60s server-side.
 */
export async function getVolumeStats(): Promise<VolumeStats> {
  const key = "volume-stats";
  const cached = getCached<VolumeStats>(key);
  if (cached) return cached;

  try {
    const stats = await fetchJson<VolumeStats>(apiUrl("/solver/volume/stats"));
    setCache(key, stats);
    return stats;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch volume stats");
    throw new Error("Failed to fetch volume stats from SODAX API");
  }
}

/**
 * Get current orderbook entries from solver
 */
export async function getOrderbook(options: {
  limit?: number;
  offset?: number;
  srcChain?: number;
  dstChain?: number;
  inputToken?: string;
  outputToken?: string;
  creator?: string;
  deadlineBefore?: number;
  deadlineAfter?: number;
  excludeZeroDeadline?: boolean;
}): Promise<OrderbookEntry[]> {
  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue;
      // Skip booleans set to false. The upstream `?flag=false` is unsafe
      // because some query parsers treat presence (any non-empty string) as
      // truthy — `excludeZeroDeadline=false` would then *exclude* zero-
      // deadline intents when the caller asked to include them. The default
      // is "don't exclude", so omitting matches the intended behavior.
      if (value === false) continue;
      params.append(key, String(value));
    }

    const queryString = params.toString();
    const url = apiUrl(`/solver/orderbook${queryString ? `?${queryString}` : ""}`);
    const data = await fetchJson<{ data?: OrderbookEntry[] } | OrderbookEntry[]>(url);
    // API returns { total, data }
    return (data as { data?: OrderbookEntry[] })?.data || (data as OrderbookEntry[]) || [];
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch orderbook");
    throw new Error("Failed to fetch orderbook from SODAX API");
  }
}

/**
 * List lending/borrowing assets in money market
 */
export async function getMoneyMarketAssets(chainId?: string): Promise<MoneyMarketAsset[]> {
  const key = cacheKey("mm-assets", chainId);
  const cached = getCached<MoneyMarketAsset[]>(key);
  if (cached) return cached;

  try {
    // Always use the /all endpoint, API doesn't support chainId filter
    const data = await fetchJson<unknown>(apiUrl("/moneymarket/asset/all"));
    // API returns array directly
    const assets = Array.isArray(data)
      ? (data as MoneyMarketAsset[])
      : (data as { data?: MoneyMarketAsset[] })?.data || [];
    setCache(key, assets);
    return assets;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch money market assets");
    throw new Error("Failed to fetch money market assets from SODAX API");
  }
}

/**
 * Get user's money market position
 */
export async function getUserPosition(userAddress: string): Promise<UserPosition | null> {
  try {
    const data = await fetchJsonOrNull<{ data?: UserPosition } | UserPosition>(
      apiUrl(`/moneymarket/position/${seg(userAddress)}`),
    );
    if (data === null) return null;
    return ((data as { data?: UserPosition })?.data || (data as UserPosition)) ?? null;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch user position");
    throw new Error("Failed to fetch user position from SODAX API");
  }
}

/**
 * List SODAX integration partners
 */
export async function getPartners(chainId?: number): Promise<Partner[]> {
  const key = cacheKey("partners", chainId);
  const cached = getCached<Partner[]>(key);
  if (cached) return cached;

  try {
    const params = new URLSearchParams();
    if (chainId !== undefined) params.append("chainId", chainId.toString());
    const queryString = params.toString();
    const url = apiUrl(`/partners${queryString ? `?${queryString}` : ""}`);
    const data = await fetchJson<unknown>(url);
    const dataObj = data as { data?: Partner[]; partners?: Partner[] } | Partner[];
    const partners = Array.isArray(dataObj) ? dataObj : dataObj?.data || dataObj?.partners || [];
    setCache(key, partners);
    return partners;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch partners");
    throw new Error("Failed to fetch partners from SODAX API");
  }
}

/**
 * Get SODA token supply info
 */
export async function getTokenSupply(): Promise<TokenSupply> {
  const key = "token-supply";
  const cached = getCached<TokenSupply>(key);
  if (cached) return cached;

  try {
    const data = await fetchJson<{ data?: TokenSupply } | TokenSupply>(apiUrl("/sodax/supply"));
    // API returns data directly
    const supply = (data as { data?: TokenSupply })?.data || (data as TokenSupply);
    setCache(key, supply);
    return supply;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch token supply");
    throw new Error("Failed to fetch token supply from SODAX API");
  }
}

/**
 * Get full config (all chains + all tokens in one call)
 */
export async function getAllConfig(): Promise<unknown> {
  const key = "config-all";
  const cached = getCached<unknown>(key);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/all"));
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch all config");
    throw new Error("Failed to fetch config from SODAX API");
  }
}

/**
 * Get chain ID to intent relay chain ID mapping
 */
export async function getRelayChainIdMap(): Promise<unknown> {
  const key = "relay-chain-id-map";
  const cached = getCached<unknown>(key);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/relay/chain-id-map"));
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch relay chain ID map");
    throw new Error("Failed to fetch relay chain ID map from SODAX API");
  }
}

/**
 * Get full spoke chain configs
 */
export async function getAllChainsConfigs(): Promise<unknown> {
  const key = "all-chains-configs";
  const cached = getCached<unknown>(key);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/spoke/all-chains-configs"));
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch all chains configs");
    throw new Error("Failed to fetch spoke chain configs from SODAX API");
  }
}

/**
 * Get hub (Sonic) assets representing spoke tokens
 */
export async function getHubAssets(chainId?: string): Promise<unknown> {
  const key = cacheKey("hub-assets", chainId);
  const cached = getCached<unknown>(key);
  if (cached) return cached;

  try {
    const endpoint = chainId ? `/config/hub/${seg(chainId)}/assets` : "/config/hub/assets";
    const data = await fetchJson<unknown>(apiUrl(endpoint));
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch hub assets");
    throw new Error("Failed to fetch hub assets from SODAX API");
  }
}

/**
 * Get money market supported tokens
 */
export async function getMoneyMarketTokens(chainId?: string): Promise<unknown> {
  const key = cacheKey("mm-tokens", chainId);
  const cached = getCached<unknown>(key);
  if (cached) return cached;

  try {
    const endpoint = chainId ? `/config/money-market/${seg(chainId)}/tokens` : "/config/money-market/tokens";
    const data = await fetchJson<unknown>(apiUrl(endpoint));
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch money market tokens");
    throw new Error("Failed to fetch money market tokens from SODAX API");
  }
}

/**
 * Get money market reserve assets
 */
export async function getMoneyMarketReserveAssets(): Promise<unknown> {
  const key = "mm-reserve-assets";
  const cached = getCached<unknown>(key);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/money-market/reserve-assets"));
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch money market reserve assets");
    throw new Error("Failed to fetch money market reserve assets from SODAX API");
  }
}

/**
 * Get AMM NFT liquidity positions
 */
export async function getAmmNftPositions(options?: {
  owner?: string;
  offset?: number;
  limit?: number;
}): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.owner) params.append("owner", options.owner);
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.limit) params.append("limit", options.limit.toString());

    const queryString = params.toString();
    const url = apiUrl(`/amm/nft-positions${queryString ? `?${queryString}` : ""}`);
    return await fetchJson<unknown>(url);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch AMM NFT positions");
    throw new Error("Failed to fetch AMM NFT positions from SODAX API");
  }
}

/**
 * Get OHLCV candle data for an AMM pool
 */
export async function getAmmPoolCandles(
  chainId: string,
  poolId: string,
  options?: { interval?: string; from?: number; to?: number },
): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.interval) params.append("interval", options.interval);
    if (options?.from) params.append("from", options.from.toString());
    if (options?.to) params.append("to", options.to.toString());

    const queryString = params.toString();
    const url = apiUrl(`/amm/pools/${seg(chainId)}/${seg(poolId)}/candles${queryString ? `?${queryString}` : ""}`);
    return await fetchJson<unknown>(url);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch AMM pool candles");
    throw new Error("Failed to fetch AMM pool candles from SODAX API");
  }
}

/**
 * Look up an intent by its intent hash (not tx hash)
 */
export async function getIntent(intentHash: string): Promise<unknown> {
  try {
    const data = await fetchJsonOrNull<{ data?: unknown }>(apiUrl(`/intent/${seg(intentHash)}`));
    if (data === null) return null;
    return data?.data ?? data ?? null;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch intent");
    throw new Error("Failed to fetch intent from SODAX API");
  }
}

/**
 * Get solver intent details by intent hash
 */
export async function getSolverIntent(intentHash: string, includeAll?: boolean): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (includeAll) params.append("includeAll", "true");

    const queryString = params.toString();
    const url = apiUrl(`/solver/intents/${seg(intentHash)}${queryString ? `?${queryString}` : ""}`);
    return await fetchJsonOrNull<unknown>(url);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch solver intent");
    throw new Error("Failed to fetch solver intent from SODAX API");
  }
}

/**
 * Get a single money market asset by reserve address
 */
export async function getMoneyMarketAsset(reserveAddress: string): Promise<unknown> {
  try {
    return await fetchJsonOrNull<unknown>(apiUrl(`/moneymarket/asset/${seg(reserveAddress)}`));
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch money market asset");
    throw new Error("Failed to fetch money market asset from SODAX API");
  }
}

/**
 * Get borrowers for a specific money market asset
 */
export async function getMoneyMarketAssetBorrowers(
  reserveAddress: string,
  options?: { offset?: number; limit?: number },
): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.limit) params.append("limit", options.limit.toString());

    const queryString = params.toString();
    const url = apiUrl(`/moneymarket/asset/${seg(reserveAddress)}/borrowers${queryString ? `?${queryString}` : ""}`);
    return await fetchJson<unknown>(url);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch asset borrowers");
    throw new Error("Failed to fetch money market asset borrowers from SODAX API");
  }
}

/**
 * Get suppliers for a specific money market asset
 */
export async function getMoneyMarketAssetSuppliers(
  reserveAddress: string,
  options?: { offset?: number; limit?: number },
): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.limit) params.append("limit", options.limit.toString());

    const queryString = params.toString();
    const url = apiUrl(`/moneymarket/asset/${seg(reserveAddress)}/suppliers${queryString ? `?${queryString}` : ""}`);
    return await fetchJson<unknown>(url);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch asset suppliers");
    throw new Error("Failed to fetch money market asset suppliers from SODAX API");
  }
}

/**
 * Get all money market borrowers
 */
export async function getMoneyMarketBorrowers(options?: {
  offset?: number;
  limit?: number;
}): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.limit) params.append("limit", options.limit.toString());

    const queryString = params.toString();
    const url = apiUrl(`/moneymarket/borrowers${queryString ? `?${queryString}` : ""}`);
    return await fetchJson<unknown>(url);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch borrowers");
    throw new Error("Failed to fetch money market borrowers from SODAX API");
  }
}

/**
 * Get partner summary by receiver address
 */
export async function getPartnerSummary(receiver: string, chainId?: string): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (chainId) params.append("chainId", chainId);

    const queryString = params.toString();
    const url = apiUrl(`/partners/${seg(receiver)}/summary${queryString ? `?${queryString}` : ""}`);
    return await fetchJsonOrNull<unknown>(url);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch partner summary");
    throw new Error("Failed to fetch partner summary from SODAX API");
  }
}

/**
 * Get SODA total supply (plain number)
 */
export async function getTotalSupply(): Promise<unknown> {
  try {
    return await fetchJson<unknown>(apiUrl("/sodax/total_supply"));
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch total supply");
    throw new Error("Failed to fetch total supply from SODAX API");
  }
}

/**
 * Get SODA circulating supply (plain number)
 */
export async function getCirculatingSupply(): Promise<unknown> {
  try {
    return await fetchJson<unknown>(apiUrl("/sodax/circulating_supply"));
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch circulating supply");
    throw new Error("Failed to fetch circulating supply from SODAX API");
  }
}

/**
 * Clear all cached data
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys()),
  };
}
