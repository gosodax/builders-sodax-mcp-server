/**
 * SODAX Solver API Service
 *
 * Client for the SODAX solver endpoints (intent oracle + quote).
 * Hosted at https://api.sodax.com/v1/intent — separate from the backend
 * API (/v1/be) and the relay service.
 */

import { CACHE_DURATION_MS, SODAX_SOLVER_BASE_URL } from "../constants.js";
import type { OraclePrice, QuoteRequest, QuoteResponse } from "../types.js";
import { fetchJson } from "./http.js";
import { logger } from "./logger.js";

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
    const data = await fetchJson<unknown>(solverUrl("/oracle"));
    if (!Array.isArray(data)) {
      // Surface contract drift loudly rather than silently caching an empty
      // list — a 2xx response with an unexpected shape is almost certainly
      // an upstream change we want to know about.
      throw new Error(`Unexpected oracle response shape: expected array, got ${typeof data}`);
    }
    const prices = data as OraclePrice[];
    setCache(cacheKey, prices);
    return prices;
  } catch (error) {
    logger.error({ err: error }, "Error fetching solver oracle");
    throw new Error(
      `Failed to fetch solver oracle prices: ${error instanceof Error ? error.message : "Unknown error"}`,
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
    const data = await fetchJson<unknown>(solverUrl("/quote"), {
      method: "POST",
      body: request,
    });
    // Defensive: matches the getSolverOracle pattern. The http layer now
    // throws on empty/whitespace bodies, but a 2xx with a non-object or
    // missing-quoted_amount payload would still slip through as `undefined`
    // downstream and surface a confusing TypeError at the tool layer.
    if (typeof data !== "object" || data === null || typeof (data as QuoteResponse).quoted_amount !== "string") {
      throw new Error(`Unexpected quote response shape: ${JSON.stringify(data)?.slice(0, 200) ?? typeof data}`);
    }
    return data as QuoteResponse;
  } catch (error) {
    logger.error({ err: error }, "Error fetching solver quote");
    throw new Error(`Failed to fetch solver quote: ${error instanceof Error ? error.message : "Unknown error"}`);
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
