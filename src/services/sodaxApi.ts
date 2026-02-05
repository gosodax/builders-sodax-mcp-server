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
  options?: { chainId?: string; limit?: number; offset?: number }
): Promise<Transaction[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit) params.append("limit", options.limit.toString());
    if (options?.offset) params.append("offset", options.offset.toString());

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
 */
export async function getVolume(options?: {
  chainId?: number;
  inputToken?: string;
  outputToken?: string;
  solver?: string;
  fromBlock?: number;
  toBlock?: number;
  since?: string;
  until?: string;
  sort?: "asc" | "desc";
  limit?: number;
  includeData?: boolean;
  cursor?: string;
}): Promise<VolumeData> {
  // Build cache key from significant params
  const cacheKey = `volume-${options?.chainId || "all"}-${options?.limit || 50}-${options?.cursor || "start"}`;
  const cached = getCached<VolumeData>(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams();
    if (options?.chainId) params.append("chainId", options.chainId.toString());
    if (options?.inputToken) params.append("inputToken", options.inputToken);
    if (options?.outputToken) params.append("outputToken", options.outputToken);
    if (options?.solver) params.append("solver", options.solver);
    if (options?.fromBlock) params.append("fromBlock", options.fromBlock.toString());
    if (options?.toBlock) params.append("toBlock", options.toBlock.toString());
    if (options?.since) params.append("since", options.since);
    if (options?.until) params.append("until", options.until);
    if (options?.sort) params.append("sort", options.sort);
    if (options?.limit) params.append("limit", options.limit.toString());
    if (options?.includeData !== undefined) params.append("includeData", options.includeData.toString());
    if (options?.cursor) params.append("cursor", options.cursor);

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
export async function getOrderbook(options?: {
  limit?: number;
}): Promise<OrderbookEntry[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit) params.append("limit", options.limit.toString());

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
  userAddress: string,
  chainId?: string
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
export async function getPartners(): Promise<Partner[]> {
  const cacheKey = "partners";
  const cached = getCached<Partner[]>(cacheKey);
  if (cached) return cached;

  try {
    const response = await apiClient.get("/partners");
    const partners = response.data?.data || response.data || [];
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
