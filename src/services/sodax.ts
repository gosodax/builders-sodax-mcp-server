/**
 * The SODAX SDK, behind narrow functions. The SDK itself is loaded only when the swap tools are
 * on (it pulls in every chain's client library): `initSodax()` runs once at boot. Its packaged
 * config (`@sodax/types`) is plain data and is read directly.
 *
 * Every call here keeps SDK errors in: their text can carry RPC URLs (paid ones embed keys),
 * request bodies and addresses, so callers only ever see `undefined` or a bare error.
 */

import {
  type EvmSpokeOnlyChainKey,
  HUB_CHAIN_KEY,
  type SpokeChainKey,
  getIntentRelayChainId,
  isSuiChainKey,
  solverConfig,
  spokeChainConfig,
} from "@sodax/types";
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

/** `rpcUrls` overrides the packaged RPC per chain key (see `parseRpcOverrides`). */
export async function initSodax(rpcUrls: Record<string, string> = {}): Promise<void> {
  if (loaded) return;
  const sdk = await import("@sodax/sdk");
  const chains = Object.fromEntries(Object.entries(rpcUrls).map(([chainKey, rpcUrl]) => [chainKey, { rpcUrl }]));
  const options = { api: { baseURL: `${SODAX_API_ORIGIN}/v1` }, logger: sdkLogger, chains };
  loaded = { sdk, sodax: new sdk.Sodax(options as ConstructorParameters<Sdk["Sodax"]>[0]) };
}

type ChainConfig = { chain?: { type?: string; chainId?: unknown }; addresses?: Record<string, unknown> };
const chainConfigs = spokeChainConfig as Record<string, ChainConfig | undefined>;

/**
 * `SODAX_RPC_URL_<evmChainId>` overrides by chain key; without one the SDK's packaged RPC is used.
 * A bad one stops the boot, named by its variable, never its value (paid URLs embed keys).
 */
export function parseRpcOverrides(env: NodeJS.ProcessEnv): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const chainId = /^SODAX_RPC_URL_(\d+)$/.exec(name)?.[1];
    if (!chainId || !value) continue;
    const chainKey = Object.keys(chainConfigs).find(key => evmChainIdFor(key) === Number(chainId));
    if (!chainKey) throw new Error(`${name} doesn't name a SODAX EVM chain id`);
    if (!URL.canParse(value) || new URL(value).protocol !== "https:") throw new Error(`${name} must be an https URL`);
    overrides[chainKey] = value;
  }
  return overrides;
}

function sdk() {
  if (!loaded) throw new Error("The SODAX SDK isn't loaded: initSodax() runs at boot when the swap tools are on");
  return loaded;
}

export const isHubChain = (chainKey: string) => chainKey === HUB_CHAIN_KEY;

/** A recipient as intents carry it, or `undefined` if the address isn't valid for the chain (EIP-55 included). */
export function encodeRecipient(chainKey: string, address: string): string | undefined {
  try {
    // The SDK pads a short Sui address, an EVM one included, to 32 bytes: only the full form is taken.
    if (isSuiChainKey(chainKey as SpokeChainKey) && !/^0x[0-9a-fA-F]{64}$/.test(address)) return undefined;
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
  const contract = isHubChain(chainKey)
    ? solverConfig.intentsContract
    : chainConfigs[chainKey]?.addresses?.assetManager;
  return asEvmAddress(contract);
}

/** A chain's EVM chain id, from the packaged config. */
export function evmChainIdFor(chainKey: string): number | undefined {
  const chain = chainConfigs[chainKey]?.chain;
  return chain?.type === "EVM" && typeof chain.chainId === "number" ? chain.chainId : undefined;
}

/** A token as the packaged config lists it on a chain (addresses compared as the SDK does), if it does. */
export function packagedToken(chainKey: string, address: string): { decimals: number; hubAsset: string } | undefined {
  type Token = { address: string; decimals: number; hubAsset: string };
  const config = spokeChainConfig as Record<string, { supportedTokens?: Record<string, Token> } | undefined>;
  const wanted = address.toLowerCase();
  return Object.values(config[chainKey]?.supportedTokens ?? {}).find(token => token.address.toLowerCase() === wanted);
}

/** A chain's id in an intent (`srcChain`, `dstChain`): the relay's, not the EVM one (Arbitrum is 23). */
export function intentChainId(chainKey: string): string | undefined {
  const id: unknown = getIntentRelayChainId(chainKey as SpokeChainKey);
  return typeof id === "bigint" ? id.toString() : undefined;
}

/**
 * Whether a mixed-case EVM address carries a valid EIP-55 checksum. Unchecked before initSodax:
 * only the swap tools use such an address, and they load the SDK at boot.
 */
export function checksumValid(address: string): boolean {
  const hex = address.slice(2);
  if (!loaded || hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  return encodeRecipient(HUB_CHAIN_KEY, address) !== undefined;
}

/**
 * The spoke's `connection` contract, from the packaged config. Its `Message` log is the proof that a
 * deposit or a cancel was sent to the hub. The hub has none.
 */
export function connectionFor(chainKey: string): string | undefined {
  return isHubChain(chainKey) ? undefined : asEvmAddress(chainConfigs[chainKey]?.addresses?.connection);
}

const asEvmAddress = (value: unknown) =>
  typeof value === "string" && EVM_ADDRESS_PATTERN.test(value) ? value : undefined;

const SDK_CALL_TIMEOUT_MS = 15_000;
const RPC_CALL_TIMEOUT_MS = 8_000;

/** A bounded SDK call whose failure (timeout included) carries no SDK text. */
async function bounded<T>(call: () => Promise<T>, timeoutMs = SDK_CALL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
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

export interface EvmReceipt {
  reverted: boolean;
  logs: { address: string; topics: string[]; data: string }[];
}

// viem's not-found errors are told apart by name; their messages carry the RPC URL.
const isNotFound = (error: unknown) =>
  error instanceof Error && /^Transaction(Receipt)?NotFoundError$/.test(error.name);

/** A mined tx's receipt on an EVM spoke, or `null` while it isn't mined. Fails as a bare error. */
export function getEvmReceipt(chainKey: string, txHash: string): Promise<EvmReceipt | null> {
  return bounded(async () => {
    const client = sdk().sodax.spoke.evm.getPublicClient(chainKey as EvmSpokeOnlyChainKey);
    try {
      const { status, logs } = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      return {
        reverted: status !== "success",
        logs: logs.map(({ address, topics, data }) => ({ address, topics: [...topics], data })),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }, RPC_CALL_TIMEOUT_MS);
}

/** Whether an EVM spoke's node knows the tx at all, mined or pending. */
export function isTxKnown(chainKey: string, txHash: string): Promise<boolean> {
  return bounded(async () => {
    const client = sdk().sodax.spoke.evm.getPublicClient(chainKey as EvmSpokeOnlyChainKey);
    try {
      await client.getTransaction({ hash: txHash as `0x${string}` });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }, RPC_CALL_TIMEOUT_MS);
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
    const sdkIntent = toSdkIntent(intent);
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

/**
 * What a cancel sends the user's hub wallet: one `cancelIntent(intent)` call on the intents contract,
 * as the SDK builds it for its own cancels. `undefined` if the SDK can't.
 */
export function cancelPayload(intent: IntentJson): string | undefined {
  try {
    const result = sdk().sodax.swaps.getCancelIntentRelayData(toSdkIntent(intent));
    return result.ok ? result.value.payload : undefined;
  } catch {
    return undefined;
  }
}

type SdkIntent = Parameters<Sdk["EvmSolverService"]["reconstructCreateIntentData"]>[0];

/** The SDK's Intent takes the numbers as bigints; the rest is the same hex the API returned. */
function toSdkIntent(intent: IntentJson): SdkIntent {
  return {
    ...intent,
    intentId: BigInt(intent.intentId),
    inputAmount: BigInt(intent.inputAmount),
    minOutputAmount: BigInt(intent.minOutputAmount),
    deadline: BigInt(intent.deadline),
    srcChain: BigInt(intent.srcChain),
    dstChain: BigInt(intent.dstChain),
  } as unknown as SdkIntent;
}

/** `approve(spender, amount)` calldata on an ERC-20, as the SDK encodes it. */
export function approveCalldata(token: string, spender: string, amount: bigint): string {
  return sdk().sdk.Erc20Service.encodeApprove(token as `0x${string}`, spender as `0x${string}`, amount).data;
}
