/**
 * The bridge catalog: what bridge-api lists at `/v1/bridge/tokens`, built from the SDK's packaged config the same way
 * (its `projectBridgeTokens`): each chain's supported tokens that have a hub asset and a vault, less the leverage-yield
 * share tokens, which leave through their own withdraw flow. No API call, so an SDK bump brings new chains and tokens
 * with no code change, and only tokens this server's own SDK can rebuild a bridge for are listed. Checked like the swap
 * catalog (`parseCatalog`), so the resolver and balance reads take either.
 */

import { sodaxConfig, spokeChainConfig } from "@sodax/types";
import { type SwapCatalog, parseCatalog } from "../swap/tokens.js";

interface PackagedToken {
  hubAsset: string;
  vault: string;
}

// The shape the packaged config has; only what's filtered on is named.
const chains = spokeChainConfig as Record<string, { supportedTokens?: Record<string, PackagedToken> }>;

let catalog: SwapCatalog | undefined;

export function getBridgeCatalog(): SwapCatalog {
  catalog ??= parseCatalog(bridgeTokens(), spokeChainConfig, "bridge");
  return catalog;
}

function bridgeTokens(): Record<string, PackagedToken[]> {
  const leverageShares = new Set(sodaxConfig.leverageYield.vaults.map(({ vault }) => vault.toLowerCase()));
  const bridgeable = (token: PackagedToken) =>
    token.hubAsset !== "0x" && token.vault !== "0x" && !leverageShares.has(token.hubAsset.toLowerCase());
  return Object.fromEntries(
    Object.entries(chains).map(([chainKey, chain]) => [
      chainKey,
      Object.values(chain?.supportedTokens ?? {}).filter(bridgeable),
    ]),
  );
}
