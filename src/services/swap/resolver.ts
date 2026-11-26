/**
 * Resolve what a person names (a chain, a token on it, an address) against the swap catalog.
 *
 * Tokens: first rule that matches wins: contract address → `native` or an exact symbol →
 * a fuzzy match (always `ambiguous`: USDT0 is not USDT) → `not_found` with suggestions,
 * and any other chains that list the query as a non-native token address or a symbol.
 * Returns structure only; each tool words its own next step.
 */

import { ZERO_ADDRESS_PATTERN, chainDisplayName } from "../../constants.js";
import { encodeRecipient } from "../sodax.js";
import { type ChainInfo, resolveChainKey } from "../sodaxApi.js";
import { ActionError, type ErrorOption } from "./errors.js";
import { rejectHex64, rejectHex64Account } from "./secrets.js";
import { pinnedSourceOf } from "./sources/index.js";
import { type SwapCatalog, type SwapsApiToken, canUseAs, findToken, nativeToken } from "./tokens.js";

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
export function resolveSwapChain(
  catalog: SwapCatalog,
  chainQuery: string,
  sourcesOnly = false,
  field = "chain",
): ChainInfo {
  const key = findChainKey(catalog, chainQuery);
  if (key) return toChain(key);
  const supported = swapChains(catalog, sourcesOnly);
  const near = nearestChains(supported, chainQuery);
  const names = near.map(chain => chain.name).join(" or ");
  throw new ActionError("UNSUPPORTED_CHAIN", "No SODAX swap chain matches that name, key or chain id.", {
    details: { field, supportedChains: supported, ...(near.length > 0 && { didYouMean: near }) },
    // The close matches first, then every other chain the sentence offers.
    hint: {
      options: chainOptions([...near, ...supported.filter(chain => !near.some(n => n.key === chain.key))], field),
    },
    nextStep:
      near.length > 0
        ? `Ask the user whether they mean ${names}, or else which chain in error.supportedChains, and pass its key.`
        : undefined,
  });
}

/** A chain a swap can start from: a source in the SDK config, of the family the live catalog says (`sourceChainFor`). */
export function isSwapSource(catalog: SwapCatalog, chainKey: string): boolean {
  const source = pinnedSourceOf(chainKey);
  return source !== undefined && catalog.chains[chainKey]?.type === source.adapter.family;
}

/** The catalog's swap chains, or only those a swap can start from. */
export function swapChains(catalog: SwapCatalog, sourcesOnly = false): ChainInfo[] {
  return Object.keys(catalog.tokens)
    .filter(key => !sourcesOnly || isSwapSource(catalog, key))
    .map(toChain);
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
  const chainField = side ? `${side}Chain` : "chain";
  const resolution = resolveToken(catalog, chainQuery, query, field, side === "from", chainField);
  if (resolution.status !== "resolved") {
    // Only what this side can use: a token allowed on it. On the sending side, or without a side (a balance read),
    // only the chain asked about: the address given is that chain's, and may not be the user's on another.
    const usable = (token: SwapsApiToken) =>
      side === "to"
        ? canUseAs(token, side)
        : token.chainKey === resolution.chain.key && (!side || canUseAs(token, side));
    throw new ActionError("UNKNOWN_TOKEN", "That token doesn't resolve to exactly one swap token.", {
      details: { field, ...(side && { side }) },
      hint: { options: resolutionOptions(resolution, { token: field, chain: chainField }, usable) },
    });
  }
  return resolution;
}

/** Chains to pick from, as options setting `field` to the chain's key. */
export function chainOptions(chains: ChainInfo[], field: string): ErrorOption[] {
  return chains.map(chain => ({ label: chain.name, args: { [field]: chain.key } }));
}

/**
 * The catalog's tokens an unresolved query offers, as options setting the token field (and the chain field, which
 * names the chain each is on). Labels and values are catalog symbols, addresses and chain keys only.
 */
export function resolutionOptions(
  resolution: Exclude<Resolution, { status: "resolved" }>,
  fields: { token: string; chain: string },
  usable: (token: SwapsApiToken) => boolean = () => true,
): ErrorOption[] {
  const here = (tokens: SwapsApiToken[]) =>
    tokens.filter(usable).map(token => ({
      label: `${tokenLabel(token, tokens)} on ${resolution.chain.name}`,
      args: { [fields.chain]: resolution.chain.key, [fields.token]: token.address },
    }));
  if (resolution.status === "ambiguous") return here(resolution.candidates);
  return [
    ...here(resolution.suggestions),
    ...(resolution.otherChains ?? [])
      .filter(({ token }) => usable(token))
      .map(({ chain, token }) => ({
        label: `${token.symbol} on ${chain.name}`,
        args: { [fields.chain]: chain.key, [fields.token]: token.address },
      })),
  ];
}

/** The symbol, and where twins share it, the address that tells them apart. */
export function tokenLabel(token: SwapsApiToken, among: SwapsApiToken[]): string {
  const twins = among.filter(other => other.symbol.toLowerCase() === token.symbol.toLowerCase());
  return twins.length > 1 ? `${token.symbol} (${twinAddress(token, twins)})` : token.symbol;
}

/** Head and tail, as a prefix alone repeats (every Hedera address starts `0x00000000`); in full when those collide. */
function twinAddress(token: SwapsApiToken, twins: SwapsApiToken[]): string {
  const short = shortAddress(token.address);
  return twins.some(other => other !== token && shortAddress(other.address) === short) ? token.address : short;
}

function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

export function resolveToken(
  catalog: SwapCatalog,
  chainQuery: string,
  query: string,
  field = "query",
  sourcesOnly = false,
  chainField = "chain",
): Resolution {
  const chain = resolveSwapChain(catalog, chainQuery, sourcesOnly, chainField);
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
  // A 64-hex value that isn't a token here may be a pasted private key; where it's also a valid account
  // (a NEAR contract account, a Sui package id), it may as well be a token this list doesn't have.
  if (encodeRecipient(chain.key, q)) rejectHex64Account(q, field, chain.name);
  else rejectHex64(q, field, chain.name, "token");

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
  // address is each chain's own gas token, not one token. The sentinels are checked by value too, since
  // `isNative` is unset on a chain whose config is missing.
  const sentinel = ZERO_ADDRESS_PATTERN.test(q) || q.toLowerCase() === EVM_NATIVE_PLACEHOLDER;
  const otherChains = Object.keys(catalog.tokens)
    .filter(other => other !== chain.key)
    .flatMap(other => {
      const byAddress = sentinel ? undefined : findToken(catalog, other, q);
      const token =
        byAddress && !byAddress.isNative
          ? byAddress
          : catalog.tokens[other].find(listed => listed.symbol.toLowerCase() === q.toLowerCase());
      return token ? [{ chain: toChain(other), token }] : [];
    });
  return { ...notFound(suggest(tokens, needle)), ...(otherChains.length > 0 && { otherChains }) };
}

/** By name, ticker, key or EVM chain id ("42161" or "0xa4b1"). */
function findChainKey(catalog: SwapCatalog, query: string): string | undefined {
  return resolveChainKey(query, Object.keys(catalog.tokens)).key ?? undefined;
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
