/**
 * The swap catalog: the Swaps API's token list, with each chain's native token
 * marked from the live chain config. Fetched together and cached.
 *
 * Every string here ends up in what the agent reads, so a chain or token that
 * doesn't look like one is dropped rather than passed on.
 */

import { z } from "zod";
import { CACHE_DURATION_MS, SODAX_SWAPS_BASE_URL } from "../../constants.js";
import { fetchJson } from "../http.js";
import { logger } from "../logger.js";
import { getAllChainsConfigs } from "../sodaxApi.js";
import { ActionError } from "./errors.js";

const SYMBOL_PATTERN = /^[A-Za-z0-9 ._()+-]{1,32}$/;
// Live keys look like "sonic", "0xa4b1.arbitrum", "injective-1"; no "_", so "__proto__" can't pass.
const CHAIN_KEY_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;

const tokenSchema = z.object({
  symbol: z.string().regex(SYMBOL_PATTERN),
  // Live names carry "•", "&" and run to ~75 characters; control, format and line/paragraph separators are refused.
  name: z.string().regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,128}$/u),
  decimals: z.number().int().min(0).max(255),
  // EVM hex, base58, Sui coin types (`::`), NEAR/Stacks names, Injective denoms (`/`).
  address: z.string().regex(/^[A-Za-z0-9:_/.-]{1,128}$/),
  chainKey: z.string().regex(CHAIN_KEY_PATTERN),
  hubAsset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  access: z.enum(["withdrawOnly", "depositOnly"]).optional(),
  /** A tokenized stock, ETF or commodity. */
  isRwa: z.boolean().optional(),
});

export type SwapsApiToken = z.infer<typeof tokenSchema> & { isNative: boolean };

/** Tokens by chain key. */
export type SwapCatalog = Record<string, SwapsApiToken[]>;

// Token lists change rarely, so a catalog this old is still served while a refresh runs.
const STALE_LIMIT_MS = 30 * 60 * 1000;
// After a failed refresh, the stale catalog is served without asking upstream again for this long.
const RETRY_AFTER_FAILURE_MS = 30 * 1000;

let cached: { catalog: SwapCatalog; fetchedAt: number } | undefined;
let inFlight: Promise<SwapCatalog> | undefined;
let lastFailureAt = Number.NEGATIVE_INFINITY;
let generation = 0;

/**
 * Fresh for CACHE_DURATION_MS. After that, a catalog younger than STALE_LIMIT_MS is
 * returned at once while one refresh runs in the background (none for a while after
 * a failure), so a slow or failing upstream never holds up a call. Past that,
 * callers wait for the refresh.
 */
export function getSwapCatalog(): Promise<SwapCatalog> {
  const current = cached;
  const now = Date.now();
  const age = current ? now - current.fetchedAt : Number.POSITIVE_INFINITY;
  if (current && age < CACHE_DURATION_MS) return Promise.resolve(current.catalog);
  if (current && age < STALE_LIMIT_MS) {
    if (now - lastFailureAt >= RETRY_AFTER_FAILURE_MS) {
      inFlight ??= refreshCatalog();
      inFlight.catch(() => undefined); // logged in loadCatalog; the stale catalog stands
    }
    return Promise.resolve(current.catalog);
  }
  inFlight ??= refreshCatalog();
  return inFlight;
}

function refreshCatalog(): Promise<SwapCatalog> {
  const startedIn = generation;
  return loadCatalog()
    .then(
      catalog => {
        if (startedIn === generation) cached = { catalog, fetchedAt: Date.now() };
        return catalog;
      },
      error => {
        if (startedIn === generation) lastFailureAt = Date.now();
        throw error;
      },
    )
    .finally(() => {
      if (startedIn === generation) inFlight = undefined;
    });
}

/** Make the next call refresh, while the current catalog still covers an outage. */
export function expireSwapCatalog(): void {
  if (cached) cached = { ...cached, fetchedAt: Math.min(cached.fetchedAt, Date.now() - CACHE_DURATION_MS) };
  lastFailureAt = Number.NEGATIVE_INFINITY;
}

/** Forget the catalog, including a load still in flight. */
export function clearSwapCatalogCache(): void {
  generation++;
  cached = undefined;
  inFlight = undefined;
  lastFailureAt = Number.NEGATIVE_INFINITY;
}

async function loadCatalog(): Promise<SwapCatalog> {
  try {
    const [rawTokens, rawConfigs] = await Promise.all([
      fetchJson<unknown>(`${SODAX_SWAPS_BASE_URL}/tokens`),
      getAllChainsConfigs(),
    ]);
    const catalog = parseCatalog(rawTokens, rawConfigs);
    const chains = Object.values(catalog);
    if (!chains.some(tokens => tokens.length > 0)) logger.error("The swap token list has no usable tokens");
    // Every live chain has one; none at all means the chain config changed shape.
    else if (!chains.some(tokens => tokens.some(token => token.isNative))) logger.error("No native token is marked");
    else return catalog;
  } catch (error) {
    logger.error({ err: error }, "Failed to load the swap token catalog");
  }
  throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX swap token list is unavailable.");
}

export function parseCatalog(rawTokens: unknown, rawConfigs: unknown): SwapCatalog {
  const configs = asRecord(rawConfigs);
  const catalog: SwapCatalog = {};
  let dropped = 0;
  for (const [chainKey, list] of Object.entries(asRecord(rawTokens))) {
    const entries = Array.isArray(list) ? list : [];
    if (!CHAIN_KEY_PATTERN.test(chainKey)) {
      dropped += entries.length;
      continue;
    }
    const native = asRecord(configs[chainKey]).nativeToken;
    const nativeAddress = typeof native === "string" ? canonicalAddress(native) : undefined;
    catalog[chainKey] = entries.flatMap(entry => {
      const parsed = tokenSchema.safeParse(entry);
      if (!parsed.success) {
        dropped++;
        return [];
      }
      return [{ ...parsed.data, isNative: canonicalAddress(parsed.data.address) === nativeAddress }];
    });
  }
  if (dropped > 0) logger.warn({ dropped }, "Dropped swap tokens that failed validation");
  return catalog;
}

/** The token at `address` on `chainKey`, if the catalog lists it, however the address is spelled. */
export function findToken(catalog: SwapCatalog, chainKey: string, address: string): SwapsApiToken | undefined {
  const wanted = canonicalAddress(address);
  return catalog[chainKey]?.find(token => canonicalAddress(token.address) === wanted);
}

/**
 * One spelling per address: hex addresses (EVM, ICON `cx`, Injective `peggy0x` and
 * `ibc/` denoms) in lower case, a Sui coin type's package id without leading zeros
 * (`0x2::sui::SUI`). Everything else (base58, names) is exact.
 */
function canonicalAddress(address: string): string {
  if (/^(0x|cx|peggy0x)[0-9a-f]{40}$/i.test(address) || /^ibc\/[0-9a-f]{64}$/i.test(address)) {
    return address.toLowerCase();
  }
  const coinType = /^0x([0-9a-f]{1,64})(::.+)$/i.exec(address);
  if (coinType) return `0x${coinType[1].toLowerCase().replace(/^0+(?=.)/, "")}${coinType[2]}`;
  return address;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
