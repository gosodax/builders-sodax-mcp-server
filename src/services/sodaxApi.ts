/**
 * SODAX API Service
 * 
 * Client for fetching live data from the SODAX API.
 * Provides access to chains, tokens, transactions, volume, and more.
 */

import axios, { AxiosInstance } from "axios";
import { SODAX_API_BASE_URL, CACHE_DURATION_MS } from "../constants.js";
import type {
  Chain,
  SwapToken,
  Transaction,
  VolumeData,
  OrderbookEntry,
  MoneyMarketAsset,
  UserPosition,
  Partner,
  TokenSupply
} from "../types.js";

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

// Create axios instance for SODAX API
const apiClient: AxiosInstance = axios.create({
  baseURL: SODAX_API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json"
  }
});

/**
 * Get all supported blockchain networks
 */
export async function getSupportedChains(): Promise<Chain[]> {
  const cacheKey = "chains";
  const cached = getCached<Chain[]>(cacheKey);
  if (cached) return cached;

  try {
    const response = await apiClient.get("/config/spoke/chains");
    // API returns array directly
    const chains = Array.isArray(response.data) ? response.data : (response.data?.data || []);
    setCache(cacheKey, chains);
    return chains;
  } catch (error) {
    console.error("Error fetching chains:", error);
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
    const response = await apiClient.get(endpoint);
    // API returns object keyed by chain ID, flatten if getting all
    const data = response.data;
    let tokens: SwapToken[] = [];
    if (chainId && Array.isArray(data)) {
      tokens = data;
    } else if (typeof data === "object" && !Array.isArray(data)) {
      // Flatten all chain tokens into single array
      for (const chain of Object.keys(data)) {
        const chainTokens = data[chain];
        if (Array.isArray(chainTokens)) {
          tokens.push(...chainTokens.map(t => ({ ...t, chainId: chain })));
        }
      }
    } else {
      tokens = data?.data || [];
    }
    setCache(cacheKey, tokens);
    return tokens;
  } catch (error) {
    console.error("Error fetching swap tokens:", error);
    throw new Error("Failed to fetch swap tokens from SODAX API");
  }
}

/**
 * Look up a transaction/intent by hash
 */
export async function getTransaction(txHash: string): Promise<Transaction | null> {
  try {
    const response = await apiClient.get(`/intent/tx/${txHash}`);
    return response.data?.data || response.data || null;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.error("Error fetching transaction:", error);
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
    startDate?: string;
    endDate?: string;
    fromTs?: number;
    toTs?: number;
  }
): Promise<Transaction[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit) params.append("limit", options.limit.toString());
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.startDate) params.append("startDate", options.startDate);
    if (options?.endDate) params.append("endDate", options.endDate);
    if (options?.fromTs !== undefined) params.append("fromTs", options.fromTs.toString());
    if (options?.toTs !== undefined) params.append("toTs", options.toTs.toString());

    const queryString = params.toString();
    const url = `/intent/user/${userAddress}${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    // API returns { items, total, offset, limit }
    return response.data?.items || response.data?.data || [];
  } catch (error) {
    console.error("Error fetching user transactions:", error);
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
    const url = `/solver/volume${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    const volumeData = response.data;
    setCache(cacheKey, volumeData);
    return volumeData;
  } catch (error) {
    console.error("Error fetching volume:", error);
    throw new Error("Failed to fetch volume data from SODAX API");
  }
}

/**
 * Get current orderbook entries from solver
 */
export async function getOrderbook(options: {
  limit: number;
  offset?: number;
}): Promise<OrderbookEntry[]> {
  try {
    const params = new URLSearchParams();
    params.append("limit", options.limit.toString());
    if (options.offset !== undefined) params.append("offset", options.offset.toString());

    const queryString = params.toString();
    const url = `/solver/orderbook${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    // API returns { total, data }
    return response.data?.data || response.data || [];
  } catch (error) {
    console.error("Error fetching orderbook:", error);
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
    const response = await apiClient.get("/moneymarket/asset/all");
    // API returns array directly
    const assets = Array.isArray(response.data) ? response.data : (response.data?.data || []);
    setCache(cacheKey, assets);
    return assets;
  } catch (error) {
    console.error("Error fetching money market assets:", error);
    throw new Error("Failed to fetch money market assets from SODAX API");
  }
}

/**
 * Get user's money market position
 */
export async function getUserPosition(
  userAddress: string
): Promise<UserPosition | null> {
  try {
    const response = await apiClient.get(`/moneymarket/position/${userAddress}`);
    return response.data?.data || response.data || null;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.error("Error fetching user position:", error);
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
    const url = `/partners${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    const partners = response.data?.data || response.data?.partners || response.data || [];
    setCache(cacheKey, partners);
    return partners;
  } catch (error) {
    console.error("Error fetching partners:", error);
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
    const response = await apiClient.get("/sodax/supply");
    // API returns data directly
    const supply = response.data?.data || response.data;
    setCache(cacheKey, supply);
    return supply;
  } catch (error) {
    console.error("Error fetching token supply:", error);
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
    const response = await apiClient.get("/config/all");
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    console.error("Error fetching all config:", error);
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
    const response = await apiClient.get("/config/relay/chain-id-map");
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    console.error("Error fetching relay chain ID map:", error);
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
    const response = await apiClient.get("/config/spoke/all-chains-configs");
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    console.error("Error fetching all chains configs:", error);
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
    const response = await apiClient.get(endpoint);
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    console.error("Error fetching hub assets:", error);
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
    const response = await apiClient.get(endpoint);
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    console.error("Error fetching money market tokens:", error);
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
    const response = await apiClient.get("/config/money-market/reserve-assets");
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    console.error("Error fetching money market reserve assets:", error);
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
    const url = `/amm/nft-positions${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    return response.data;
  } catch (error) {
    console.error("Error fetching AMM NFT positions:", error);
    throw new Error("Failed to fetch AMM NFT positions from SODAX API");
  }
}

/**
 * Get OHLCV candle data for an AMM pool
 */
export async function getAmmPoolCandles(
  chainId: string,
  poolId: string,
  options?: { interval?: string; from?: number; to?: number }
): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.interval) params.append("interval", options.interval);
    if (options?.from) params.append("from", options.from.toString());
    if (options?.to) params.append("to", options.to.toString());

    const queryString = params.toString();
    const url = `/amm/pools/${chainId}/${poolId}/candles${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    return response.data;
  } catch (error) {
    console.error("Error fetching AMM pool candles:", error);
    throw new Error("Failed to fetch AMM pool candles from SODAX API");
  }
}

/**
 * Look up an intent by its intent hash (not tx hash)
 */
export async function getIntent(intentHash: string): Promise<unknown> {
  try {
    const response = await apiClient.get(`/intent/${intentHash}`);
    return response.data?.data || response.data || null;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.error("Error fetching intent:", error);
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
    const url = `/solver/intents/${intentHash}${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.error("Error fetching solver intent:", error);
    throw new Error("Failed to fetch solver intent from SODAX API");
  }
}

/**
 * Get a single money market asset by reserve address
 */
export async function getMoneyMarketAsset(reserveAddress: string): Promise<unknown> {
  try {
    const response = await apiClient.get(`/moneymarket/asset/${reserveAddress}`);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.error("Error fetching money market asset:", error);
    throw new Error("Failed to fetch money market asset from SODAX API");
  }
}

/**
 * Get borrowers for a specific money market asset
 */
export async function getMoneyMarketAssetBorrowers(
  reserveAddress: string,
  options?: { offset?: number; limit?: number }
): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.limit) params.append("limit", options.limit.toString());

    const queryString = params.toString();
    const url = `/moneymarket/asset/${reserveAddress}/borrowers${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    return response.data;
  } catch (error) {
    console.error("Error fetching asset borrowers:", error);
    throw new Error("Failed to fetch money market asset borrowers from SODAX API");
  }
}

/**
 * Get suppliers for a specific money market asset
 */
export async function getMoneyMarketAssetSuppliers(
  reserveAddress: string,
  options?: { offset?: number; limit?: number }
): Promise<unknown> {
  try {
    const params = new URLSearchParams();
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.limit) params.append("limit", options.limit.toString());

    const queryString = params.toString();
    const url = `/moneymarket/asset/${reserveAddress}/suppliers${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    return response.data;
  } catch (error) {
    console.error("Error fetching asset suppliers:", error);
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
    const url = `/moneymarket/borrowers${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    return response.data;
  } catch (error) {
    console.error("Error fetching borrowers:", error);
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
    const url = `/partners/${receiver}/summary${queryString ? `?${queryString}` : ""}`;
    const response = await apiClient.get(url);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.error("Error fetching partner summary:", error);
    throw new Error("Failed to fetch partner summary from SODAX API");
  }
}

/**
 * Get SODA total supply (plain number)
 */
export async function getTotalSupply(): Promise<unknown> {
  try {
    const response = await apiClient.get("/sodax/total_supply");
    return response.data;
  } catch (error) {
    console.error("Error fetching total supply:", error);
    throw new Error("Failed to fetch total supply from SODAX API");
  }
}

/**
 * Get SODA circulating supply (plain number)
 */
export async function getCirculatingSupply(): Promise<unknown> {
  try {
    const response = await apiClient.get("/sodax/circulating_supply");
    return response.data;
  } catch (error) {
    console.error("Error fetching circulating supply:", error);
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
    keys: Array.from(cache.keys())
  };
}
