/**
 * SODAX Solver API Service
 *
 * Client for the SODAX solver endpoints (intent oracle + quote).
 * Hosted at https://api.sodax.com/v1/intent — separate from the backend
 * API (/v1/be) and the relay service.
 */

import { SODAX_SOLVER_BASE_URL, CACHE_DURATION_MS } from "../constants.js";
import { fetchJson } from "./http.js";
import type { OraclePrice, QuoteRequest, QuoteResponse } from "../types.js";

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

function solverUrl(path: string): string {
  return `${SODAX_SOLVER_BASE_URL}${path}`;
}

/**
 * Get the solver's oracle prices for all tokens it can quote on.
 * Returns one entry per (chainId, token) the solver tracks.
 */
export async function getSolverOracle(): Promise<OraclePrice[]> {
  const cacheKey = "solver-oracle";
  const cached = getCached<OraclePrice[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<OraclePrice[]>(solverUrl("/oracle"));
    const prices = Array.isArray(data) ? data : [];
    setCache(cacheKey, prices);
    return prices;
  } catch (error) {
    console.error("Error fetching solver oracle:", error);
    throw new Error(
      `Failed to fetch solver oracle prices: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Get a swap quote from the solver.
 * The solver searches for a path between token_src and token_dst and
 * returns a quoted_amount in the destination token's smallest unit.
 *
 * Errors come back as `{ detail: { code, message } }` — surfaced as
 * a thrown Error with the upstream message attached.
 */
export async function getSolverQuote(request: QuoteRequest): Promise<QuoteResponse> {
  try {
    return await fetchJson<QuoteResponse>(solverUrl("/quote"), {
      method: "POST",
      body: request,
    });
  } catch (error) {
    console.error("Error fetching solver quote:", error);
    throw new Error(
      `Failed to fetch solver quote: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Clear all cached solver data.
 */
export function clearSolverCache(): void {
  cache.clear();
}

/**
 * Get solver cache statistics.
 */
export function getSolverCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys()),
  };
}
