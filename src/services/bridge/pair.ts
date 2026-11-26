/**
 * Whether a bridge between two resolved tokens can be built, checked before any call to the Bridge API: what neither
 * the SDK's build nor bridge-api's checks (the shared vault), what bridge-api checks only on its build routes (each
 * token's `access`), and what the vaults take now.
 */

import { HUB_CHAIN_KEY } from "@sodax/types";
import { sameHex as same } from "../../constants.js";
import { type ChainToken, bridgeLimit, bridgeableTokensTo } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { ActionError } from "../swap/errors.js";
import { resolveSwapChain, toChain, tokenLabel } from "../swap/resolver.js";
import { chainRead, sourceChainFor } from "../swap/source.js";
import { type SwapCatalog, type SwapsApiToken, canUseAs, findToken } from "../swap/tokens.js";
import { formatUnits } from "../swap/units.js";
import { getBridgeCatalog } from "./catalog.js";

/** One side of a bridge, as the resolver returns it. */
export interface BridgeSide {
  chain: ChainInfo;
  token: SwapsApiToken;
}

export const chainToken = ({ chain, token }: BridgeSide): ChainToken => ({
  chainKey: chain.key,
  address: token.address,
});

/** What a token bridges to on another chain (the SDK's: those sharing its hub vault), as the catalog lists them. */
function bridgeTargets(catalog: SwapCatalog, from: ChainToken, toChainKey: string): SwapsApiToken[] {
  return bridgeableTokensTo(from, toChainKey)
    .map(address => findToken(catalog, toChainKey, address))
    .filter((token): token is SwapsApiToken => token !== undefined && canUseAs(token, "to"));
}

function sameChain(chain: ChainInfo): ActionError {
  return new ActionError("BRIDGE_REJECTED", `A bridge moves a token to another chain, and both are ${chain.name}.`, {
    nextStep: "Ask the user which other chain to bridge to.",
    details: { reason: "same_chain", field: "toChain" },
  });
}

/**
 * Refuses a pair that can't be bridged, offering the tokens the source does bridge to on that chain. Each side is
 * already usable on its side (`resolveSide`).
 */
export function checkBridgePair(catalog: SwapCatalog, from: BridgeSide, to: BridgeSide): void {
  if (from.chain.key === to.chain.key) throw sameChain(from.chain);
  const targets = bridgeTargets(catalog, chainToken(from), to.chain.key);
  if (targets.some(token => same(token.address, to.token.address))) return;
  const named = `${from.token.symbol} on ${from.chain.name}`;
  const labels = targets.map(token => tokenLabel(token, targets));
  throw new ActionError("BRIDGE_REJECTED", `${named} can't be bridged to ${to.token.symbol} on ${to.chain.name}.`, {
    nextStep:
      targets.length > 0
        ? `${named} bridges only to ${labels.join(", ")} on ${to.chain.name}: ask the user which, or which other chain to bridge to.`
        : `${named} can't be bridged to ${to.chain.name}: ask the user which other chain or token to bridge.`,
    details: { reason: "not_bridgeable", field: "toToken" },
    hint: {
      options: targets.map((token, i) => ({
        label: `${labels[i]} on ${to.chain.name}`,
        args: { toChain: to.chain.key, toToken: token.address },
      })),
    },
  });
}

/** Refuses an amount (source base units) above what the vaults take now, else names that most. Reads the hub. */
export async function checkBridgeLimit(amount: bigint, from: BridgeSide, to: BridgeSide): Promise<string> {
  const limit = await chainRead(toChain(HUB_CHAIN_KEY), () => bridgeLimit(chainToken(from), chainToken(to)));
  const { decimals, symbol } = from.token;
  // The limit's decimals are its vault token's: compared across both precisions in integers, never rounded.
  const scale = (value: bigint, by: number) => value * 10n ** BigInt(by);
  // Rounded down to what the source can send: never more than the limit.
  const most = scale(limit.amount, decimals) / 10n ** BigInt(limit.decimals);
  if (scale(amount, limit.decimals) <= scale(limit.amount, decimals)) return formatUnits(most, decimals);
  const route = `from ${from.chain.name} to ${to.chain.name}`;
  // A cap lowered below what's deposited leaves less than nothing: no room either.
  if (most <= 0n) {
    throw new ActionError("BRIDGE_REJECTED", `${symbol} can't be bridged ${route} right now.`, {
      nextStep: `Tell the user ${symbol} can't be bridged ${route} right now; ask whether to try later, or another token or chain.`,
      details: { reason: "no_capacity" },
    });
  }
  const maxAmount = formatUnits(most, decimals);
  throw new ActionError("BRIDGE_REJECTED", `At most ${maxAmount} ${symbol} can be bridged ${route} right now.`, {
    nextStep: `Ask the user whether to bridge ${maxAmount} ${symbol} or less instead.`,
    details: { reason: "above_limit", field: "amount", maxAmount },
  });
}

/** A token that bridges, and the one it arrives as, as the catalog lists both. */
export interface BridgePair {
  from: { symbol: string; address: string };
  to: { symbol: string; address: string };
}

export interface BridgePairs {
  status: "ok";
  from: ChainInfo;
  to: ChainInfo;
  pairs: BridgePair[];
}

export interface BridgeDestinations {
  status: "ok";
  from: ChainInfo;
  /** Each chain something on `from` bridges to, with the symbols sent that do. */
  destinations: { chain: ChainInfo; symbols: string[] }[];
}

/** Every token a bridge can send from one chain, with each token it arrives as on another. Config only, no read. */
export function listBridgePairs(fromChain: string, toChain: string): BridgePairs {
  const catalog = getBridgeCatalog();
  const from = sourceChain(catalog, fromChain);
  const to = resolveSwapChain(catalog, toChain, false, "toChain");
  if (from.key === to.key) throw sameChain(from);
  return { status: "ok", from, to, pairs: pairsBetween(catalog, from.key, to.key) };
}

// Per source chain: the catalog is built once, so what a chain reaches never changes while the server runs.
const reachedFrom = new Map<string, BridgeDestinations["destinations"]>();

/** Every chain a bridge can reach from one chain, with what bridges there. Config only, no read. */
export function listBridgeDestinations(fromChain: string): BridgeDestinations {
  const catalog = getBridgeCatalog();
  const from = sourceChain(catalog, fromChain);
  let destinations = reachedFrom.get(from.key);
  if (!destinations) {
    destinations = Object.keys(catalog.chains)
      .filter(key => key !== from.key)
      .map(key => ({
        chain: toChain(key),
        symbols: [...new Set(pairsBetween(catalog, from.key, key).map(pair => pair.from.symbol))],
      }))
      .filter(({ symbols }) => symbols.length > 0);
    reachedFrom.set(from.key, destinations);
  }
  return { status: "ok", from, destinations };
}

function sourceChain(catalog: SwapCatalog, query: string): ChainInfo {
  const chain = resolveSwapChain(catalog, query, true, "fromChain");
  sourceChainFor(catalog, chain);
  return chain;
}

function pairsBetween(catalog: SwapCatalog, fromKey: string, toKey: string): BridgePair[] {
  return (catalog.tokens[fromKey] ?? [])
    .filter(token => canUseAs(token, "from"))
    .flatMap(sent =>
      bridgeTargets(catalog, { chainKey: fromKey, address: sent.address }, toKey).map(received => ({
        from: { symbol: sent.symbol, address: sent.address },
        to: { symbol: received.symbol, address: received.address },
      })),
    );
}
