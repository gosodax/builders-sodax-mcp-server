/**
 * The chains a swap can start from, each with its adapter, pinned from the SDK's packaged config: plain data, so
 * the chain support tool answers the same without the SDK loaded.
 */

import { spokeChainConfig } from "@sodax/types";
import { connectionFor, evmChainIdFor, isHubChain, swapContractFor } from "../../sodax.js";
import { EVM_SPOKE, HUB } from "./evm.js";
import { INJECTIVE, injectiveSender } from "./injective.js";
import { NEAR, nearSender } from "./near.js";
import { SOLANA, solanaSender } from "./solana.js";
import { STELLAR, stellarSender } from "./stellar.js";
import { SUI, suiSender } from "./sui.js";
import { NON_EVM_SOURCE_TYPES, type NonEvmSourceType, type SourceAdapter, type SourceChain } from "./types.js";

/** Each non-EVM family's adapter, and how its deposits' messages name the asset manager. */
const NON_EVM: Record<NonEvmSourceType, { adapter: SourceAdapter; sender: (assetManager: string) => string }> = {
  NEAR: { adapter: NEAR, sender: nearSender },
  STELLAR: { adapter: STELLAR, sender: stellarSender },
  SUI: { adapter: SUI, sender: suiSender },
  SOLANA: { adapter: SOLANA, sender: solanaSender },
  INJECTIVE: { adapter: INJECTIVE, sender: injectiveSender },
};

/** Every adapter, for a tx hash that may be any source's. */
export const SOURCE_ADAPTERS: readonly SourceAdapter[] = [
  EVM_SPOKE,
  HUB,
  ...Object.values(NON_EVM).map(f => f.adapter),
];

type ChainConfig = { chain?: { type?: unknown }; addresses?: { assetManager?: unknown; connection?: unknown } };
const chainConfigs = spokeChainConfig as Record<string, ChainConfig | undefined>;

const isNonEvmSourceType = (type: unknown): type is NonEvmSourceType =>
  NON_EVM_SOURCE_TYPES.includes(type as NonEvmSourceType);

const CHAINS_OF_TYPE = new Map<unknown, number>();
for (const config of Object.values(chainConfigs)) {
  const type = config?.chain?.type;
  CHAINS_OF_TYPE.set(type, (CHAINS_OF_TYPE.get(type) ?? 0) + 1);
}

/**
 * A chain's source, if a swap can start there: the hub (its intents contract logs the intent) or a spoke of any
 * family (its `connection` messages prove a deposit).
 */
export function pinnedSourceOf(chainKey: string): SourceChain | undefined {
  const type = chainConfigs[chainKey]?.chain?.type;
  if (isNonEvmSourceType(type)) {
    // An adapter reads through the SDK's one service for its family: a second chain of a family isn't read right yet.
    if (CHAINS_OF_TYPE.get(type) !== 1) return undefined;
    const { assetManager, connection } = chainConfigs[chainKey]?.addresses ?? {};
    if (typeof assetManager !== "string" || typeof connection !== "string" || !assetManager || !connection) {
      return undefined;
    }
    // Track proves a deposit by it, so a chain without one is refused at quote time, before anyone deposits.
    const depositor = assetManagerSender(chainKey, type);
    if (depositor === undefined) return undefined;
    return { kind: "spoke", adapter: NON_EVM[type].adapter, swapContract: assetManager, connection, depositor };
  }
  const chainId = evmChainIdFor(chainKey);
  const swapContract = swapContractFor(chainKey);
  if (chainId === undefined || !swapContract) return undefined;
  if (isHubChain(chainKey)) return { kind: "hub", adapter: HUB, swapContract, chainId };
  const connection = connectionFor(chainKey);
  if (!connection) return undefined;
  return { kind: "spoke", adapter: EVM_SPOKE, swapContract, chainId, connection, depositor: swapContract };
}

/** Every chain a swap can start from (`pinnedSourceOf`), by key. */
export const sourceChainKeys = () =>
  Object.keys(chainConfigs).filter(chainKey => pinnedSourceOf(chainKey) !== undefined);

/** How a deposit's message names the chain's asset manager (as its `srcAddress`), if its config has one. */
export function assetManagerSender(chainKey: string, type: NonEvmSourceType): string | undefined {
  const assetManager = chainConfigs[chainKey]?.addresses?.assetManager;
  if (typeof assetManager !== "string") return undefined;
  try {
    return NON_EVM[type].sender(assetManager);
  } catch {
    return undefined;
  }
}

/** Whether the value can be some source's tx hash, for the tool argument; its chain's own rule comes later. */
export const isAnyTxHash = (value: string) =>
  SOURCE_ADAPTERS.some(adapter => adapter.txHash.spell(value.trim()) !== undefined);
