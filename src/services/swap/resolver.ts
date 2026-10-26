/**
 * Resolve "a token on a chain", as a person would name it, against the swap catalog.
 *
 * First rule that matches wins: contract address → `native` or an exact symbol →
 * a fuzzy match (always `ambiguous`: USDT0 is not USDT) → `not_found` with suggestions.
 * Returns structure only; each tool words its own next step.
 */

import { chainDisplayName } from "../../constants.js";
import { type ChainInfo, resolveChainKey } from "../sodaxApi.js";
import { ActionError } from "./errors.js";
import { type SwapCatalog, type SwapsApiToken, findToken } from "./tokens.js";

export type Resolution =
  | { status: "resolved"; chain: ChainInfo; matchedBy: "address" | "symbol" | "native"; token: SwapsApiToken }
  | { status: "ambiguous"; chain: ChainInfo; query: string; candidates: SwapsApiToken[] }
  | { status: "not_found"; chain: ChainInfo; query: string; suggestions: SwapsApiToken[] };

const MAX_CANDIDATES = 10;
const MAX_SUGGESTIONS = 5;

export function resolveToken(catalog: SwapCatalog, chainQuery: string, query: string): Resolution {
  const chainKeys = Object.keys(catalog);
  const { key } = resolveChainKey(chainQuery, chainKeys);
  if (!key) {
    throw new ActionError("UNSUPPORTED_CHAIN", "SODAX swaps don't support that chain.", {
      details: { supportedChains: chainKeys.map(toChain) },
    });
  }

  const chain = toChain(key);
  const tokens = catalog[key];
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

  const byAddress = findToken(catalog, key, q);
  if (byAddress) return { status: "resolved", chain, matchedBy: "address", token: byAddress };

  if (q.toLowerCase() === "native") {
    const native = tokens.find(token => token.isNative);
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

  return notFound(suggest(tokens, needle));
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

function toChain(key: string): ChainInfo {
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
