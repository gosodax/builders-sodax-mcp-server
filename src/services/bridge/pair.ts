/**
 * Whether a bridge between two resolved tokens can be built, checked before any call to the Bridge API: what neither
 * the SDK's build nor bridge-api's checks (the shared vault), what bridge-api checks only on its build routes (each
 * token's `access`), and what the vaults take now.
 */

import { HUB_CHAIN_KEY } from "@sodax/types";
import { type ChainToken, bridgeLimit, bridgeableTokensTo, isBridgeable } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { ActionError } from "../swap/errors.js";
import { resolveSwapChain, toChain, tokenLabel } from "../swap/resolver.js";
import { chainRead, sourceChainFor } from "../swap/source.js";
import { type SwapCatalog, type SwapsApiToken, canUseAs, findToken } from "../swap/tokens.js";
import { formatUnits } from "../swap/units.js";
import { getBridgeCatalog } from "./catalog.js";
import { bridged } from "./wording.js";

/** One side of a bridge, as the resolver returns it. */
export interface BridgeSide {
  chain: ChainInfo;
  token: SwapsApiToken;
}

const chainToken = ({ chain, token }: BridgeSide): ChainToken => ({ chainKey: chain.key, address: token.address });

/** Refuses a pair that can't be bridged, offering the tokens the source does bridge to on that chain. */
export function checkBridgePair(catalog: SwapCatalog, from: BridgeSide, to: BridgeSide): void {
  for (const [side, { chain, token }] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (!canUseAs(token, side)) {
      throw new ActionError("RESTRICTED_TOKEN", `${token.symbol} on ${chain.name} can't be used on that side.`, {
        details: { side, field: `${side}Token` },
      });
    }
  }
  if (from.chain.key === to.chain.key) {
    throw new ActionError(
      "BRIDGE_REJECTED",
      `A bridge moves a token to another chain, and both sides are on ${from.chain.name}.`,
      { nextStep: "Ask the user which other chain to bridge to.", details: { reason: "same_chain", field: "toChain" } },
    );
  }
  if (isBridgeable(chainToken(from), chainToken(to))) return;
  // What the source token does bridge to there, as the catalog lists them and usable as the token received.
  const targets = bridgeableTokensTo(chainToken(from), to.chain.key)
    .map(address => findToken(catalog, to.chain.key, address))
    .filter((token): token is SwapsApiToken => token !== undefined && canUseAs(token, "to"));
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
  if (most === 0n) {
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

/** Every token a bridge can send from one chain, with each token it arrives as on another. Config only, no read. */
export function listBridgePairs(fromChain: string, toChain: string): BridgePairs {
  const catalog = getBridgeCatalog();
  const from = bridged(() => resolveSwapChain(catalog, fromChain, true, "fromChain"));
  const to = bridged(() => resolveSwapChain(catalog, toChain, false, "toChain"));
  bridged(() => sourceChainFor(catalog, from));
  if (from.key === to.key) {
    throw new ActionError("BRIDGE_REJECTED", `A bridge moves a token to another chain, and both are ${from.name}.`, {
      nextStep: "Ask the user which other chain to bridge to.",
      details: { reason: "same_chain", field: "toChain" },
    });
  }
  const pairs = (catalog.tokens[from.key] ?? [])
    .filter(token => canUseAs(token, "from"))
    .flatMap(sent =>
      bridgeableTokensTo({ chainKey: from.key, address: sent.address }, to.key)
        .map(address => findToken(catalog, to.key, address))
        .filter((token): token is SwapsApiToken => token !== undefined && canUseAs(token, "to"))
        .map(received => ({
          from: { symbol: sent.symbol, address: sent.address },
          to: { symbol: received.symbol, address: received.address },
        })),
    );
  return { status: "ok", from, to, pairs };
}
