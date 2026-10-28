/**
 * Resolve what a person names (a chain, a token on it, an address) against the swap catalog.
 *
 * Tokens: first rule that matches wins: contract address → `native` or an exact symbol →
 * a fuzzy match (always `ambiguous`: USDT0 is not USDT) → `not_found` with suggestions,
 * and any other chains that list the query as a non-native token address or a symbol.
 * Returns structure only; each tool words its own next step.
 */

import { chainDisplayName } from "../../constants.js";
import { encodeRecipient, evmSpokeFor } from "../sodax.js";
import { type ChainInfo, resolveChainKey } from "../sodaxApi.js";
import { ActionError } from "./errors.js";
import { rejectHex64 } from "./secrets.js";
import { type SwapCatalog, type SwapsApiToken, findToken, nativeToken } from "./tokens.js";

export type Resolution =
  | { status: "resolved"; chain: ChainInfo; matchedBy: "address" | "symbol" | "native"; token: SwapsApiToken }
  | { status: "ambiguous"; chain: ChainInfo; query: string; candidates: SwapsApiToken[] }
  | {
      status: "not_found";
      chain: ChainInfo;
      query: string;
      suggestions: SwapsApiToken[];
      otherChains?: { chain: ChainInfo; token: SwapsApiToken }[];
    };

const MAX_CANDIDATES = 10;
const MAX_SUGGESTIONS = 5;
// What many wallets and aggregators pass for an EVM chain's gas token.
const EVM_NATIVE_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * An address valid on the chain (EIP-55 for EVM), as typed. An all-zero address in any family (EVM
 * `0x0…0`, Sui `0x0`, Solana's system program) burns what it receives, so it's refused too.
 */
export function checkAddress(address: string, chain: ChainInfo, field = "address"): string {
  const encoded = encodeRecipient(chain.key, address);
  if (!encoded) rejectHex64(address, field, chain.name, "address");
  if (!encoded || /^0x0*$/.test(encoded)) {
    throw new ActionError("INVALID_ADDRESS", `That isn't a valid address on ${chain.name}.`, { details: { field } });
  }
  return address;
}

/**
 * A chain as a person would name it, or by EVM chain id. Refused otherwise with the supported list (only
 * chains a swap can start from, for a swap's source) and any within two typos.
 */
export function resolveSwapChain(catalog: SwapCatalog, chainQuery: string, sourcesOnly = false): ChainInfo {
  const key = findChainKey(catalog, chainQuery);
  if (key) return toChain(key);
  const supported = Object.keys(catalog.tokens)
    .filter(other => !sourcesOnly || isSwapSource(catalog, other))
    .map(toChain);
  const near = nearestChains(supported, chainQuery);
  const names = near.map(chain => chain.name).join(" or ");
  throw new ActionError("UNSUPPORTED_CHAIN", "No SODAX swap chain matches that name, key or chain id.", {
    details: { supportedChains: supported, ...(near.length > 0 && { didYouMean: near }) },
    nextStep:
      near.length > 0
        ? `Ask the user whether they mean ${names}, or else which chain in error.supportedChains, and pass its key.`
        : undefined,
  });
}

/** A chain a swap can start from: an EVM spoke whose deposits the SDK config can prove. */
export function isSwapSource(catalog: SwapCatalog, chainKey: string): boolean {
  return catalog.chains[chainKey]?.type === "EVM" && evmSpokeFor(chainKey) !== undefined;
}

/** The chains within two typos of the query, by name or key, closest first. */
function nearestChains(chains: ChainInfo[], query: string): ChainInfo[] {
  const needle = normalize(query);
  if (needle.length < 3) return [];
  const scored = chains.map(chain => {
    const names = [chain.name, chain.key.split(".").pop() ?? chain.key].map(normalize);
    return { chain, distance: Math.min(...names.map(name => editDistance(name, needle))) };
  });
  const best = Math.min(...scored.map(({ distance }) => distance));
  return best <= 2 ? scored.filter(({ distance }) => distance === best).map(({ chain }) => chain) : [];
}

/**
 * The one token a query names, or `UNKNOWN_TOKEN` (ambiguous or not found: `sodax_resolve_token` explains which).
 * A swap's `from` side takes only chains a swap can start from.
 */
export function resolveExactly(
  catalog: SwapCatalog,
  chainQuery: string,
  query: string,
  field: string,
  side?: "from" | "to",
): Extract<Resolution, { status: "resolved" }> {
  const resolution = resolveToken(catalog, chainQuery, query, field, side === "from");
  if (resolution.status !== "resolved") {
    throw new ActionError("UNKNOWN_TOKEN", "That token doesn't resolve to exactly one swap token.", {
      details: side && { side },
    });
  }
  return resolution;
}

export function resolveToken(
  catalog: SwapCatalog,
  chainQuery: string,
  query: string,
  field = "query",
  sourcesOnly = false,
): Resolution {
  const chain = resolveSwapChain(catalog, chainQuery, sourcesOnly);
  const tokens = catalog.tokens[chain.key];
  // A listed chain with no usable token means its entries failed validation, not that it has none.
  if (tokens.length === 0) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", `The swap token list for ${chain.name} is unavailable.`);
  }
  const q = query.trim();
  const notFound = (suggestions: SwapsApiToken[]): Resolution => ({
    status: "not_found",
    chain,
    query: q,
    suggestions,
  });

  const byAddress = findToken(catalog, chain.key, q);
  if (byAddress) return { status: "resolved", chain, matchedBy: "address", token: byAddress };
  // A 64-hex value that isn't a token here (NEAR's are matched above) may be a pasted private key.
  rejectHex64(q, field, chain.name, "token");

  const isEvm = catalog.chains[chain.key]?.type === "EVM";
  if (q.toLowerCase() === "native" || (isEvm && q.toLowerCase() === EVM_NATIVE_PLACEHOLDER)) {
    const native = nativeToken(catalog, chain.key);
    return native ? { status: "resolved", chain, matchedBy: "native", token: native } : notFound([]);
  }

  const exact = tokens.filter(token => token.symbol.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return { status: "resolved", chain, matchedBy: "symbol", token: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", chain, query: q, candidates: exact };

  // A missed address finds nothing below: it's longer than any symbol and starts no word of a name.
  const needle = normalize(q);
  const queryWords = words(q);
  if (needle.length >= 2) {
    const fuzzy = tokens
      .filter(token => normalize(token.symbol).includes(needle) || startsWordsOf(token.name, queryWords))
      .sort((a, b) => a.symbol.length - b.symbol.length);
    if (fuzzy.length > 0) return { status: "ambiguous", chain, query: q, candidates: fuzzy.slice(0, MAX_CANDIDATES) };
  }

  // At most one per chain, by address or else by exact symbol. Never a native token by address: the zero
  // address is each chain's own gas token, not one token.
  const otherChains = Object.keys(catalog.tokens)
    .filter(other => other !== chain.key)
    .flatMap(other => {
      const byAddress = findToken(catalog, other, q);
      const token =
        byAddress && !byAddress.isNative
          ? byAddress
          : catalog.tokens[other].find(listed => listed.symbol.toLowerCase() === q.toLowerCase());
      return token ? [{ chain: toChain(other), token }] : [];
    });
  return { ...notFound(suggest(tokens, needle)), ...(otherChains.length > 0 && { otherChains }) };
}

/**
 * By name, ticker or key, then by EVM chain id ("42161" or "0xa4b1"). The id is matched against
 * the chain config, never a key prefix: "0x1.icon" is ICON, not chain id 1.
 */
function findChainKey(catalog: SwapCatalog, query: string): string | undefined {
  const keys = Object.keys(catalog.tokens);
  const { key } = resolveChainKey(query, keys);
  if (key) return key;
  const id = chainIdQuery(query);
  if (id === undefined) return undefined;
  return keys.find(other => catalog.chains[other]?.type === "EVM" && catalog.chains[other].chainId === id);
}

/** An EVM chain id typed as a query, in decimal or hex. */
export function chainIdQuery(query: string): number | undefined {
  const q = query.trim();
  return /^(\d{1,15}|0x[0-9a-f]{1,12})$/i.test(q) ? Number(q) : undefined;
}

/** The native token first for a wrapped-native guess (WETH on a chain whose gas token is ETH), then near misses. */
function suggest(tokens: SwapsApiToken[], needle: string): SwapsApiToken[] {
  const suggestions: SwapsApiToken[] = [];
  const native = tokens.find(token => token.isNative);
  if (native && needle === `w${normalize(native.symbol)}`) suggestions.push(native);
  if (needle.length >= 3) {
    for (const token of tokens) {
      if (!suggestions.includes(token) && editDistance(normalize(token.symbol), needle) <= 2) suggestions.push(token);
    }
  }
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

export function toChain(key: string): ChainInfo {
  return { key, name: chainDisplayName(key) };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The query's words start at a word of the name: "eth" and "wrapped ether" match "Wrapped Ether"; "eth" doesn't match "Tether USD". */
function startsWordsOf(name: string, queryWords: string[]): boolean {
  if (queryWords.length === 0) return false;
  const nameWords = words(name);
  const phrase = queryWords.join(" ");
  return nameWords.some((_, i) => nameWords.slice(i).join(" ").startsWith(phrase));
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}
