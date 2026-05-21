/**
 * SODAX API Service
 *
 * Client for fetching live data from the SODAX API.
 * Provides access to chains, tokens, transactions, volume, and more.
 */

import { CACHE_DURATION_MS, SODAX_API_BASE_URL } from "../constants.js";
import type {
  Chain,
  MoneyMarketAsset,
  OrderbookEntry,
  Partner,
  SwapToken,
  TokenSupply,
  Transaction,
  UserPosition,
  VolumeData,
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
 * Get all supported blockchain networks
 */
export async function getSupportedChains(): Promise<Chain[]> {
  const cacheKey = "chains";
  const cached = getCached<Chain[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/spoke/chains"));
    // API returns array directly
    const chains = Array.isArray(data) ? (data as Chain[]) : (data as { data?: Chain[] })?.data || [];
    setCache(cacheKey, chains);
    return chains;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch supported chains");
    throw new Error("Failed to fetch supported chains from SODAX API");
  }
}

/**
 * Get available tokens for swapping on a specific chain
 */
export async function getSwapTokens(chainId?: string): Promise<SwapToken[]> {
  const cacheKey = `tokens-${chainId || "all"}`;
  const cached = getCached<SwapToken[]>(cacheKey);
  if (cached) return cached;

  try {
    const endpoint = chainId ? `/config/swap/${chainId}/tokens` : "/config/swap/tokens";
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
    setCache(cacheKey, tokens);
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
    const data = await fetchJsonOrNull<{ data?: Transaction } | Transaction>(apiUrl(`/intent/tx/${txHash}`));
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
    const url = apiUrl(`/intent/user/${userAddress}${queryString ? `?${queryString}` : ""}`);
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
  const cacheKey = `volume-${options.inputToken}-${options.outputToken}-${options.chainId || "all"}-${options.limit || 50}-${options.cursor || "start"}`;
  const cached = getCached<VolumeData>(cacheKey);
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
    setCache(cacheKey, volumeData);
    return volumeData;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch volume");
    throw new Error("Failed to fetch volume data from SODAX API");
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
      if (value !== undefined) params.append(key, String(value));
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
  const cacheKey = `mm-assets-${chainId || "all"}`;
  const cached = getCached<MoneyMarketAsset[]>(cacheKey);
  if (cached) return cached;

  try {
    // Always use the /all endpoint, API doesn't support chainId filter
    const data = await fetchJson<unknown>(apiUrl("/moneymarket/asset/all"));
    // API returns array directly
    const assets = Array.isArray(data)
      ? (data as MoneyMarketAsset[])
      : (data as { data?: MoneyMarketAsset[] })?.data || [];
    setCache(cacheKey, assets);
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
      apiUrl(`/moneymarket/position/${userAddress}`),
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
  const cacheKey = `partners-${chainId ?? "all"}`;
  const cached = getCached<Partner[]>(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams();
    if (chainId !== undefined) params.append("chainId", chainId.toString());
    const queryString = params.toString();
    const url = apiUrl(`/partners${queryString ? `?${queryString}` : ""}`);
    const data = await fetchJson<unknown>(url);
    const dataObj = data as { data?: Partner[]; partners?: Partner[] } | Partner[];
    const partners = Array.isArray(dataObj) ? dataObj : dataObj?.data || dataObj?.partners || [];
    setCache(cacheKey, partners);
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
  const cacheKey = "token-supply";
  const cached = getCached<TokenSupply>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{ data?: TokenSupply } | TokenSupply>(apiUrl("/sodax/supply"));
    // API returns data directly
    const supply = (data as { data?: TokenSupply })?.data || (data as TokenSupply);
    setCache(cacheKey, supply);
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
  const cacheKey = "config-all";
  const cached = getCached<unknown>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/all"));
    setCache(cacheKey, data);
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
  const cacheKey = "relay-chain-id-map";
  const cached = getCached<unknown>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/relay/chain-id-map"));
    setCache(cacheKey, data);
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
  const cacheKey = "all-chains-configs";
  const cached = getCached<unknown>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/spoke/all-chains-configs"));
    setCache(cacheKey, data);
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
  const cacheKey = `hub-assets-${chainId || "all"}`;
  const cached = getCached<unknown>(cacheKey);
  if (cached) return cached;

  try {
    const endpoint = chainId ? `/config/hub/${chainId}/assets` : "/config/hub/assets";
    const data = await fetchJson<unknown>(apiUrl(endpoint));
    setCache(cacheKey, data);
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
  const cacheKey = `mm-tokens-${chainId || "all"}`;
  const cached = getCached<unknown>(cacheKey);
  if (cached) return cached;

  try {
    const endpoint = chainId ? `/config/money-market/${chainId}/tokens` : "/config/money-market/tokens";
    const data = await fetchJson<unknown>(apiUrl(endpoint));
    setCache(cacheKey, data);
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
  const cacheKey = "mm-reserve-assets";
  const cached = getCached<unknown>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<unknown>(apiUrl("/config/money-market/reserve-assets"));
    setCache(cacheKey, data);
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
    const url = apiUrl(`/amm/pools/${chainId}/${poolId}/candles${queryString ? `?${queryString}` : ""}`);
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
    const data = await fetchJsonOrNull<{ data?: unknown }>(apiUrl(`/intent/${intentHash}`));
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
    const url = apiUrl(`/solver/intents/${intentHash}${queryString ? `?${queryString}` : ""}`);
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
    return await fetchJsonOrNull<unknown>(apiUrl(`/moneymarket/asset/${reserveAddress}`));
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
    const url = apiUrl(`/moneymarket/asset/${reserveAddress}/borrowers${queryString ? `?${queryString}` : ""}`);
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
    const url = apiUrl(`/moneymarket/asset/${reserveAddress}/suppliers${queryString ? `?${queryString}` : ""}`);
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
    const url = apiUrl(`/partners/${receiver}/summary${queryString ? `?${queryString}` : ""}`);
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
