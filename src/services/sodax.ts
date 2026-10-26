/**
 * The SODAX SDK, loaded only when the swap tools are on: it pulls in every chain's client
 * library. `initSodax()` runs once at boot; swap code reads it through `getSdk()`.
 */

import { SODAX_API_ORIGIN } from "../constants.js";
import { logger } from "./logger.js";

type SdkModule = typeof import("@sodax/sdk");
type TypesModule = typeof import("@sodax/types");

export interface LoadedSdk {
  sodax: InstanceType<SdkModule["Sodax"]>;
  /** A recipient as intents carry it; throws on an address that isn't valid for the chain. */
  encodeAddress: SdkModule["encodeAddress"];
  /** Packaged chain config: each spoke's asset manager. */
  spokeChainConfig: TypesModule["spokeChainConfig"];
  /** The hub contract a swap from the hub goes to. */
  intentsContract: string;
  hubChainKey: string;
  hederaChainKey: string;
}

let loaded: LoadedSdk | undefined;

// The SDK logs raw errors and data, whose text can carry RPC URLs (paid ones embed keys) and
// addresses; only its own message gets through.
export const sdkLogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => logger.warn({ source: "sodax-sdk" }, message),
  error: (message: string) => logger.error({ source: "sodax-sdk" }, message),
};

export async function initSodax(): Promise<LoadedSdk> {
  if (loaded) return loaded;
  const [sdk, types] = await Promise.all([import("@sodax/sdk"), import("@sodax/types")]);
  loaded = {
    sodax: new sdk.Sodax({ api: { baseURL: `${SODAX_API_ORIGIN}/v1` }, logger: sdkLogger }),
    encodeAddress: sdk.encodeAddress,
    spokeChainConfig: types.spokeChainConfig,
    intentsContract: types.solverConfig.intentsContract,
    hubChainKey: types.HUB_CHAIN_KEY,
    hederaChainKey: types.ChainKeys.HEDERA_MAINNET,
  };
  return loaded;
}

export function getSdk(): LoadedSdk {
  if (!loaded) throw new Error("The SODAX SDK isn't loaded: initSodax() runs at boot when the swap tools are on");
  return loaded;
}
