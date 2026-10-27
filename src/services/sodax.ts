/**
 * The SODAX SDK, behind narrow functions. The SDK itself is loaded only when the swap tools are
 * on (it pulls in every chain's client library): `initSodax()` runs once at boot. Its packaged
 * config (`@sodax/types`) is plain data and is read directly.
 *
 * Every call here keeps SDK errors in: their text can carry RPC URLs (paid ones embed keys),
 * request bodies and addresses, so callers only ever see `undefined` or a bare error.
 */

import { HUB_CHAIN_KEY, type SpokeChainKey, solverConfig, spokeChainConfig } from "@sodax/types";
import { EVM_ADDRESS_PATTERN, SODAX_API_ORIGIN } from "../constants.js";
import { logger } from "./logger.js";

type Sdk = typeof import("@sodax/sdk");

let loaded: { sdk: Sdk; sodax: InstanceType<Sdk["Sodax"]> } | undefined;

// The SDK logs raw errors and data; only its own message gets through.
export const sdkLogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => logger.warn({ source: "sodax-sdk" }, message),
  error: (message: string) => logger.error({ source: "sodax-sdk" }, message),
};

export async function initSodax(): Promise<void> {
  if (loaded) return;
  const sdk = await import("@sodax/sdk");
  loaded = { sdk, sodax: new sdk.Sodax({ api: { baseURL: `${SODAX_API_ORIGIN}/v1` }, logger: sdkLogger }) };
}

function sdk() {
  if (!loaded) throw new Error("The SODAX SDK isn't loaded: initSodax() runs at boot when the swap tools are on");
  return loaded;
}

export const isHubChain = (chainKey: string) => chainKey === HUB_CHAIN_KEY;

/** A recipient as intents carry it, or `undefined` if the address isn't valid for the chain (EIP-55 included). */
export function encodeRecipient(chainKey: string, address: string): string | undefined {
  try {
    // Catalog chain keys are the SDK's; an unknown one throws like a bad address.
    return sdk().sdk.encodeAddress(chainKey as SpokeChainKey, address);
  } catch {
    return undefined;
  }
}

/**
 * The contract a swap from this chain calls, from the packaged config: the hub intents contract
 * from the hub, else the spoke's asset manager.
 */
export function swapContractFor(chainKey: string): string | undefined {
  const config = spokeChainConfig as Record<string, { addresses?: { assetManager?: unknown } } | undefined>;
  const contract = isHubChain(chainKey) ? solverConfig.intentsContract : config[chainKey]?.addresses?.assetManager;
  return typeof contract === "string" && EVM_ADDRESS_PATTERN.test(contract) ? contract : undefined;
}

/** A chain's EVM chain id, from the packaged config. */
export function evmChainIdFor(chainKey: string): number | undefined {
  const config = spokeChainConfig as Record<string, { chain?: { type?: unknown; chainId?: unknown } } | undefined>;
  const chain = config[chainKey]?.chain;
  return chain?.type === "EVM" && typeof chain.chainId === "number" ? chain.chainId : undefined;
}

/** A token as the packaged config lists it on a chain (addresses compared as the SDK does), if it does. */
export function packagedToken(chainKey: string, address: string): { decimals: number; hubAsset: string } | undefined {
  type Token = { address: string; decimals: number; hubAsset: string };
  const config = spokeChainConfig as Record<string, { supportedTokens?: Record<string, Token> } | undefined>;
  const wanted = address.toLowerCase();
  return Object.values(config[chainKey]?.supportedTokens ?? {}).find(token => token.address.toLowerCase() === wanted);
}

const SDK_CALL_TIMEOUT_MS = 15_000;

/** A bounded SDK call whose failure (timeout included) carries no SDK text. */
async function bounded<T>(call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), SDK_CALL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new Error("SDK call failed");
  } finally {
    clearTimeout(timer);
  }
}

/** The user's own hub wallet for an address on a chain (an intent's creator). One hub RPC read, cached by the SDK. */
export function userHubWallet(chainKey: string, address: string): Promise<string> {
  return bounded(() => sdk().sodax.hubProvider.getUserHubWalletAddress(address, chainKey as SpokeChainKey));
}

/** Whether a NEAR account has storage for the token, or a Stellar account a trustline for the amount. */
export function recipientReady(
  chainType: "NEAR" | "STELLAR",
  token: string,
  address: string,
  amount: bigint,
): Promise<boolean> {
  const { spoke } = sdk().sodax;
  return bounded(() =>
    chainType === "NEAR"
      ? spoke.near.isStorageRegistered(token, address)
      : spoke.stellar.hasSufficientTrustline(token, amount, address),
  );
}

/** The intent fields `createIntent` takes, as the Swaps API returns them. */
export interface IntentJson {
  intentId: string;
  creator: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  minOutputAmount: string;
  deadline: string;
  allowPartialFill: boolean;
  srcChain: string;
  dstChain: string;
  srcAddress: string;
  dstAddress: string;
  solver: string;
  data: string;
}

export interface SwapTx {
  to: string;
  value: bigint;
  data: string;
  /** The relay payload: what the hub wallet runs, or the hub `createIntent` itself. */
  payload: string;
}

/**
 * The swap tx for an intent, rebuilt by the SDK the way it builds its own: from a spoke, `deposit`
 * on the asset manager (gross amount, Hedera's value scaling) carrying the hub calls that create
 * the intent; from the hub, `createIntent` on the intents contract. `undefined` if the SDK can't.
 */
export async function rebuildSwapTx(params: {
  srcChainKey: string;
  srcAddress: string;
  token: string;
  /** The gross amount the user sends (the intent's input plus any partner fee). */
  amount: bigint;
  intent: IntentJson;
}): Promise<SwapTx | undefined> {
  const { srcChainKey, srcAddress, token, amount, intent } = params;
  try {
    const { sdk: lib, sodax } = sdk();
    const hub = isHubChain(srcChainKey);
    // The SDK's Intent takes the numbers as bigints; the rest is the same hex the API returned.
    const sdkIntent = {
      ...intent,
      intentId: BigInt(intent.intentId),
      inputAmount: BigInt(intent.inputAmount),
      minOutputAmount: BigInt(intent.minOutputAmount),
      deadline: BigInt(intent.deadline),
      srcChain: BigInt(intent.srcChain),
      dstChain: BigInt(intent.dstChain),
    } as unknown as Parameters<Sdk["EvmSolverService"]["reconstructCreateIntentData"]>[0];
    const payload = lib.EvmSolverService.reconstructCreateIntentData(sdkIntent, solverConfig.intentsContract, hub);
    if (hub) {
      // As the SDK's Sonic path does: value only when the hub asset is the hub's native token.
      const native = intent.inputToken.toLowerCase() === spokeChainConfig.sonic.nativeToken.toLowerCase();
      return { to: solverConfig.intentsContract, value: native ? amount : 0n, data: payload, payload };
    }
    const tx = await sodax.spoke.evm.deposit<true>({
      srcChainKey: srcChainKey as Parameters<typeof sodax.spoke.evm.deposit>[0]["srcChainKey"],
      srcAddress: srcAddress as `0x${string}`,
      token: token as `0x${string}`,
      to: intent.creator as `0x${string}`,
      amount,
      data: payload,
      raw: true,
    });
    return { to: tx.to, value: BigInt(tx.value), data: tx.data, payload };
  } catch {
    return undefined;
  }
}

/** `approve(spender, amount)` calldata on an ERC-20, as the SDK encodes it. */
export function approveCalldata(token: string, spender: string, amount: bigint): string {
  return sdk().sdk.Erc20Service.encodeApprove(token as `0x${string}`, spender as `0x${string}`, amount).data;
}
