/**
 * The SODAX SDK, behind narrow functions. The SDK itself is loaded only for the swap tools (it
 * pulls in every chain's client library): `initSodax()` runs once at boot (see index.ts). Its packaged
 * config (`@sodax/types`) is plain data and is read directly.
 *
 * Every call here keeps SDK errors in: their text can carry RPC URLs (paid ones embed keys),
 * request bodies and addresses, so callers only ever see `undefined` or a bare error.
 */

import {
  type EvmSpokeOnlyChainKey,
  type GetAddressType,
  type GetTokenAddressType,
  HUB_CHAIN_KEY,
  type SpokeChainKey,
  getIntentRelayChainId,
  isBitcoinChainKey,
  isNativeToken,
  isSolanaChainKey,
  isStellarChainKey,
  isSuiChainKey,
  solverConfig,
  spokeChainConfig,
} from "@sodax/types";
import {
  CHAIN_KEY_PATTERN,
  EVM_ADDRESS_PATTERN,
  SODAX_API_ORIGIN,
  base32Bytes,
  base58Bytes,
  isRecord,
  isRpcUrl,
  parseRpcConfigJson,
  sameHex,
} from "../constants.js";
import { HttpError, fetchJson } from "./http.js";
import { errorName, logger, redact } from "./logger.js";
import {
  type NonEvmTx,
  hexBytes,
  injectiveTxFrom,
  nearTxFrom,
  solanaTxFrom,
  stellarTxFrom,
  suiTxFrom,
} from "./swap/nonEvmSource.js";
import type { SourceChain } from "./swap/source.js";
import type { BuiltIntent } from "./swap/swapsApi.js";

type Sdk = typeof import("@sodax/sdk");

let loaded: { sdk: Sdk; sodax: InstanceType<Sdk["Sodax"]> } | undefined;

// The SDK logs raw errors and data; only its own message gets through, without URLs, as an attribute so the
// record's body stays one searchable constant.
export const sdkLogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => logger.warn({ "sdk.message": redact(String(message)) }, "SODAX SDK warning"),
  error: (message: string) => logger.error({ "sdk.message": redact(String(message)) }, "SODAX SDK error"),
};

// The RPC fields a chain's config may have, in the SDK's names (see `parseRpcOverrides`).
const RPC_FIELD_NAMES = ["rpcUrl", "grpc_url", "debugRpcUrl", "horizonRpcUrl", "sorobanRpcUrl"] as const;
type RpcField = (typeof RPC_FIELD_NAMES)[number];
export type RpcOverride = Partial<Record<RpcField, string>>;

/** `chains` overrides the packaged RPC per chain key; the SDK deep-merges each patch into that chain's config. */
export async function initSodax(chains: Record<string, RpcOverride> = {}): Promise<void> {
  if (loaded) return;
  const sdk = await import("@sodax/sdk");
  // The hub provider reads its own config, not the Sonic spoke's, so the override goes to both.
  const hubRpcUrl = chains[HUB_CHAIN_KEY]?.rpcUrl;
  const options = {
    api: { baseURL: `${SODAX_API_ORIGIN}/v1` },
    logger: sdkLogger,
    chains,
    ...(hubRpcUrl && { hub: { rpcUrl: hubRpcUrl } }),
  };
  loaded = { sdk, sodax: new sdk.Sodax(options as ConstructorParameters<Sdk["Sodax"]>[0]) };
}

type ChainConfig = { chain?: { type?: string; chainId?: unknown }; addresses?: Record<string, unknown> };
const chainConfigs = spokeChainConfig as Record<string, ChainConfig | undefined>;

/**
 * What an `RPC_CONFIG` entry may set, by chain key: the RPC fields that chain's packaged config has, so they follow
 * the SDK. Injective's `rpcUrl` is among them though its provider uses fixed mainnet endpoints (the README says so):
 * skipping it would warn on every boot over a value the backend's own format includes.
 */
function readRpcFields(): Map<string, ReadonlySet<string>> {
  const fields = new Map<string, ReadonlySet<string>>();
  for (const [chainKey, config] of Object.entries(chainConfigs)) {
    const present = config ? RPC_FIELD_NAMES.filter(field => field in config) : [];
    if (present.length > 0) fields.set(chainKey, new Set(present));
  }
  return fields;
}
const RPC_FIELDS = readRpcFields();

// A key of the secret-bearing value, as a warning names it: a URL pasted as a key would otherwise reach the logs.
const nameOf = (key: string) => (CHAIN_KEY_PATTERN.test(key) ? key : "(an unknown key)");
const fieldNameOf = (field: string) => (/^[A-Za-z_]{1,32}$/.test(field) ? field : "(an unknown field)");

/**
 * `RPC_CONFIG`, in the format the SODAX backend uses: an object keyed by chain key in the SDK's own field names
 * (`{"sonic":{"rpcUrl":"https://…"},"sui":{"grpc_url":"https://…"}}`), so the same value works in both. A chain or
 * field it leaves out, or leaves blank, keeps the SDK's packaged RPC, and so does every chain without it.
 *
 * It never stops the server: the value is shared with services on other SDK versions, so an entry this server can't
 * apply (an unknown chain or field, a value that isn't an https URL) is skipped with one warning naming it, never its
 * value (paid URLs embed keys).
 */
export function parseRpcOverrides(env: NodeJS.ProcessEnv): Record<string, RpcOverride> {
  const legacy = Object.keys(env).filter(name => name.startsWith("SODAX_RPC_URL_"));
  if (legacy.length > 0) {
    logger.warn({ "rpc_config.legacy": legacy.join(", ") }, "SODAX_RPC_URL_* is no longer read: set RPC_CONFIG");
  }
  const raw = env.RPC_CONFIG?.trim();
  if (!raw) return {};
  const config = parseRpcConfigJson(raw);
  if (!isRecord(config)) {
    logger.warn("RPC_CONFIG isn't a JSON object; every chain uses its packaged RPC");
    return {};
  }
  const overrides: Record<string, RpcOverride> = {};
  const skipped: string[] = [];
  for (const [chainKey, entry] of Object.entries(config)) {
    const fields = RPC_FIELDS.get(chainKey);
    if (!fields || !isRecord(entry)) {
      skipped.push(nameOf(chainKey));
      continue;
    }
    for (const [field, raw] of Object.entries(entry)) {
      // Trimmed: a secret pasted or set from a file often ends in a newline. Blank, as a workflow writes an unset
      // secret: not set.
      const value = typeof raw === "string" ? raw.trim() : raw;
      if (value === "") continue;
      if (fields.has(field) && isRpcUrl(value)) overrides[chainKey] = { ...overrides[chainKey], [field]: value };
      else skipped.push(`${nameOf(chainKey)}.${fieldNameOf(field)}`);
    }
  }
  if (skipped.length > 0) {
    logger.warn({ "rpc_config.skipped": skipped.join(", ") }, "RPC_CONFIG entries this server can't apply");
  }
  return overrides;
}

function sdk() {
  if (!loaded) throw new Error("The SODAX SDK isn't loaded: initSodax() runs at boot when the server has swap tools");
  return loaded;
}

export const isHubChain = (chainKey: string) => chainKey === HUB_CHAIN_KEY;

/**
 * The hub's id of an intent (IF-11: keccak256 of the ABI-encoded `createIntent` struct), as `GET /intent/:intentHash`
 * and the solver name it, from the struct the Swaps API built. Verified against the data API's own hashes.
 */
export function intentHash(intent: BuiltIntent["intent"]): string {
  const uint = (value: string) => BigInt(value);
  return sdk().sdk.EvmSolverService.getIntentHash({
    ...intent,
    intentId: uint(intent.intentId),
    inputAmount: uint(intent.inputAmount),
    minOutputAmount: uint(intent.minOutputAmount),
    deadline: uint(intent.deadline),
    srcChain: uint(intent.srcChain),
    dstChain: uint(intent.dstChain),
  } as Parameters<Sdk["EvmSolverService"]["getIntentHash"]>[0]);
}

/** A recipient as intents carry it, or `undefined` if the address isn't valid for the chain (EIP-55 included). */
export function encodeRecipient(chainKey: string, address: string): string | undefined {
  try {
    // The SDK pads a short Sui address, an EVM one included, to 32 bytes: only the full form is taken.
    if (isSuiChainKey(chainKey as SpokeChainKey) && !/^0x[0-9a-fA-F]{64}$/.test(address)) return undefined;
    // It also takes a Stellar contract (C…) or muxed (M…) address and a Bitcoin testnet one; only a
    // Stellar account and a Bitcoin mainnet address are wallets a swap should pay.
    if (isStellarChainKey(chainKey as SpokeChainKey) && !address.startsWith("G")) return undefined;
    if (isBitcoinChainKey(chainKey as SpokeChainKey) && !/^(1|3|bc1)/i.test(address)) return undefined;
    // Catalog chain keys are the SDK's; an unknown one throws like a bad address.
    const encoded = sdk().sdk.encodeAddress(chainKey as SpokeChainKey, address);
    // The SDK encodes any Stacks version, testnet (ST…, St…, SN…) included: only mainnet single- or multi-sig
    // (0x16, 0x14) is taken, in a standard (0x05) or contract (0x06) principal.
    if (chainConfigs[chainKey]?.chain?.type === "STACKS" && !/^0x0[56]1[46]/.test(encoded)) return undefined;
    return encoded;
  } catch {
    return undefined;
  }
}

/** An address as its chain spells it, from its encoding in an intent (`encodeRecipient`'s inverse), if the SDK can. */
export function decodeAddress(chainKey: string, encoded: string): string | undefined {
  try {
    return sdk().sdk.reverseEncodeAddress(chainKey as SpokeChainKey, encoded as `0x${string}`);
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
 * Whether an EVM address is all lowercase or carries a valid EIP-55 checksum, as the SDK takes it
 * (it drops a fee paid to an all-uppercase one). Unchecked before initSodax: only the swap tools
 * use such an address, and they load the SDK at boot.
 */
export function checksumValid(address: string): boolean {
  const hex = address.slice(2);
  if (!loaded || hex === hex.toLowerCase()) return true;
  return encodeRecipient(HUB_CHAIN_KEY, address) !== undefined;
}

/**
 * The spoke's `connection` contract, from the packaged config. Its `Message` log is the proof that a
 * deposit or a cancel was sent to the hub. The hub has none.
 */
export function connectionFor(chainKey: string): string | undefined {
  return isHubChain(chainKey) ? undefined : asEvmAddress(chainConfigs[chainKey]?.addresses?.connection);
}

/**
 * The non-EVM families a swap can start from. Not Bitcoin (its swaps go through a Bound trading wallet), Stacks
 * (the SDK can't build its cancel) or ICON (being retired).
 */
export const NON_EVM_SOURCE_TYPES = ["NEAR", "STELLAR", "SUI", "SOLANA", "INJECTIVE"] as const;
export type NonEvmSourceType = (typeof NON_EVM_SOURCE_TYPES)[number];

const isNonEvmSourceType = (type: unknown): type is NonEvmSourceType =>
  NON_EVM_SOURCE_TYPES.includes(type as NonEvmSourceType);

const CHAINS_OF_TYPE = new Map<unknown, number>();
for (const config of Object.values(chainConfigs)) {
  const type = config?.chain?.type;
  CHAINS_OF_TYPE.set(type, (CHAINS_OF_TYPE.get(type) ?? 0) + 1);
}

/**
 * A chain's source from the packaged config, if a swap can start there: the hub (its intents contract logs the
 * intent), an EVM spoke (its `connection` proves a deposit) or a non-EVM one (its tx carries the quoted payload).
 */
export function pinnedSourceOf(chainKey: string): SourceChain | undefined {
  const type = chainConfigs[chainKey]?.chain?.type;
  if (isNonEvmSourceType(type)) {
    // The readers use the SDK's one service per family: a second chain of a family isn't read right yet.
    if (CHAINS_OF_TYPE.get(type) !== 1) return undefined;
    const assetManager = chainConfigs[chainKey]?.addresses?.assetManager;
    if (typeof assetManager !== "string" || !assetManager) return undefined;
    // Track proves a deposit by it, so a chain without one is refused at quote time, before anyone deposits.
    const marker = assetManagerMarker(chainKey, type);
    return marker === undefined ? undefined : { family: type, swapContract: assetManager, marker };
  }
  const chainId = evmChainIdFor(chainKey);
  const swapContract = swapContractFor(chainKey);
  const connection = connectionFor(chainKey);
  if (chainId === undefined || !swapContract || (!connection && !isHubChain(chainKey))) return undefined;
  return { family: "EVM", chainId, swapContract, ...(connection && { connection }) };
}

/** Every chain a swap can start from (`pinnedSourceOf`), by key. */
export const sourceChainKeys = () =>
  Object.keys(chainConfigs).filter(chainKey => pinnedSourceOf(chainKey) !== undefined);

const asEvmAddress = (value: unknown) =>
  typeof value === "string" && EVM_ADDRESS_PATTERN.test(value) ? value : undefined;

const SDK_CALL_TIMEOUT_MS = 15_000;
const RPC_CALL_TIMEOUT_MS = 8_000;
const INJECTIVE_TRY_MS = 2_500;

/**
 * A bounded call whose failure (timeout included) carries no text of its own. One log record per call
 * (#110): what was read, on which chain, how long it took, and whether it worked.
 */
export async function bounded<T>(
  { label, chainKey, timeoutMs = SDK_CALL_TIMEOUT_MS }: { label: string; chainKey?: string; timeoutMs?: number },
  call: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const started = Date.now();
  const fields = { "sdk.call": label, "chain.key": chainKey };
  try {
    const result = await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
      }),
    ]);
    logger.info({ ...fields, "duration.ms": Date.now() - started }, "Chain read");
    return result;
  } catch (error) {
    logger.warn({ ...fields, "duration.ms": Date.now() - started, "error.type": errorName(error) }, "Chain read");
    throw new Error("SDK call failed");
  } finally {
    clearTimeout(timer);
  }
}

/** The user's own hub wallet for an address on a chain (an intent's creator). One hub RPC read, cached by the SDK. */
export function userHubWallet(chainKey: string, address: string): Promise<string> {
  return bounded({ label: "hub wallet", chainKey }, () =>
    sdk().sodax.hubProvider.getUserHubWalletAddress(address, chainKey as SpokeChainKey),
  );
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
  return bounded({ label: "receipt", chainKey, timeoutMs: RPC_CALL_TIMEOUT_MS }, async () => {
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
  });
}

/** An EVM spoke's or NEAR's latest block number: proof its RPC answers. Fails as a bare error. */
export function blockNumber(chainKey: string): Promise<bigint> {
  return bounded({ label: "block number", chainKey, timeoutMs: RPC_CALL_TIMEOUT_MS }, async () => {
    if (chainConfigs[chainKey]?.chain?.type === "NEAR") {
      const block = await sdk().sodax.spoke.near.rpcProvider.viewBlock({ finality: "final" });
      return BigInt(block.header.height);
    }
    const client = sdk().sodax.spoke.evm.getPublicClient(chainKey as EvmSpokeOnlyChainKey);
    return client.getBlockNumber();
  });
}

/** Whether an EVM spoke's node knows the tx at all, mined or pending. */
export function isTxKnown(chainKey: string, txHash: string): Promise<boolean> {
  return bounded({ label: "tx known", chainKey, timeoutMs: RPC_CALL_TIMEOUT_MS }, async () => {
    const client = sdk().sodax.spoke.evm.getPublicClient(chainKey as EvmSpokeOnlyChainKey);
    try {
      await client.getTransaction({ hash: txHash as `0x${string}` });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  });
}

// Horizon's 404, as the SDK's own `isHorizonNotFound` checks: stellar-sdk's `NotFoundError` is named "Error".
const isHorizonNotFound = (error: unknown) =>
  (error as { response?: { status?: unknown } } | undefined)?.response?.status === 404;

// Whether a failed native read says the account doesn't exist yet (unfunded), per family; told apart
// without the messages, which carry the RPC URL.
function isMissingAccount(chainKey: string, error: unknown): boolean {
  switch (chainConfigs[chainKey]?.chain?.type) {
    case "STELLAR":
      return isHorizonNotFound(error);
    case "NEAR":
      return error instanceof Error && error.name === "AccountDoesNotExistError";
    default:
      return false;
  }
}

/**
 * A wallet's balance of a catalog token in base units, the native coin included (Hedera's scaled by the
 * SDK). `null` only from a native read on Stellar or NEAR whose account doesn't exist yet: a NEAR token
 * read fails the same way for a token contract that doesn't exist. A failed read fails as a bare error:
 * never reported as 0. One read per token: the SDK's batch read reports a failed token as 0.
 */
export function walletBalance(chainKey: string, address: string, token: { address: string }): Promise<bigint | null> {
  return bounded({ label: "balance", chainKey, timeoutMs: RPC_CALL_TIMEOUT_MS }, async () => {
    const result = await sdk().sodax.spoke.getWalletBalance({
      srcChainKey: chainKey as SpokeChainKey,
      srcAddress: address as never,
      // Only the address is read, to tell the native coin from a token contract.
      token: token as never,
    });
    if (result.ok) return result.value;
    if (isNativeToken(chainKey as SpokeChainKey, token.address) && isMissingAccount(chainKey, result.error))
      return null;
    throw new Error("balance read failed");
  });
}

/**
 * Whether the SDK can check a Stellar recipient for the token: one that needs a trustline needs it listed
 * in the packaged config, which lists only some.
 */
export function stellarRecipientCheckable(token: string): boolean {
  const wanted = token.toLowerCase();
  return (
    !sdk().sodax.spoke.stellar.requiresTrustline(token) ||
    spokeChainConfig.stellar.trustlineConfigs.some(config => config.contractId.toLowerCase() === wanted)
  );
}

/**
 * Whether a NEAR account has storage for the token, or a Stellar account a trustline for the amount. A
 * Stellar account that doesn't exist yet can't receive XLM or a trustline token.
 */
export function recipientReady(
  chainType: "NEAR" | "STELLAR",
  token: string,
  address: string,
  amount: bigint,
): Promise<boolean> {
  const { near, stellar } = sdk().sodax.spoke;
  if (chainType === "NEAR") return bounded({ label: "near storage" }, () => near.isStorageRegistered(token, address));
  return bounded({ label: "stellar trustline" }, async () => {
    try {
      if (stellar.requiresTrustline(token)) return await stellar.hasSufficientTrustline(token, amount, address);
      const { chain, nativeToken } = spokeChainConfig.stellar;
      if (token.toLowerCase() === nativeToken.toLowerCase()) {
        // Reads the account, which fails as for a trustline token when it doesn't exist.
        await stellar.getWalletBalance({
          srcChainKey: chain.key,
          srcAddress: address as never,
          token: { address: token } as never,
        });
      }
      return true;
    } catch (error) {
      if (isHorizonNotFound(error)) return false;
      throw error;
    }
  });
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
  const hub = isHubChain(srcChainKey);
  const payload = createIntentPayload(intent, hub);
  if (!payload) return undefined;
  try {
    const { sodax } = sdk();
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
      data: payload as `0x${string}`,
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

// `route((address,uint256,bytes)[])` on the Sonic wallet router: it runs the calls as the sender's hub wallet.
const ROUTE_SELECTOR = "0x65a3b0a5";

/**
 * The cancel of a swap from the hub, as the SDK builds its own: the user's wallet router running exactly
 * `cancelIntent(intent)` on the intents contract, from the intent's source address, no value. `undefined` if the
 * SDK can't, or if what it built is anything else.
 */
export async function hubCancelTx(
  intent: IntentJson,
): Promise<{ from: string; to: string; value: string; data: string } | undefined> {
  try {
    const result = await sdk().sodax.swaps.createCancelIntent({
      params: { srcChainKey: HUB_CHAIN_KEY, intent: toSdkIntent(intent) },
      raw: true,
    });
    if (!result.ok) return undefined;
    const { from, to, value, data } = result.value as { from: string; to: string; value: bigint; data: string };
    const calls = cancelPayload(intent);
    const ok =
      calls !== undefined &&
      sameHex(from, intent.srcAddress) &&
      sameHex(to, spokeChainConfig.sonic.addresses.walletRouter) &&
      value === 0n &&
      sameHex(data, `${ROUTE_SELECTOR}${calls.slice(2)}`);
    return ok ? { from, to, value: "0", data } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A non-EVM spoke's swap tx, built by the SDK as its own swaps build theirs: a deposit of `amount` (gross) of `token`
 * to the user's hub wallet `to`, carrying `payload`. Unsigned, as the SDK returns it raw. Reads the chain (account,
 * blockhash, coins, fees), so it fails as a bare error.
 */
export function buildNonEvmDeposit(params: {
  srcChainKey: string;
  srcAddress: string;
  token: string;
  amount: bigint;
  to: string;
  payload: string;
}): Promise<unknown> {
  const { srcChainKey, srcAddress, token, amount, to, payload } = params;
  return bounded({ label: "deposit build", chainKey: srcChainKey }, async () => {
    // Only the values are cast: a parameter the SDK renames fails the type check, not the deposit.
    const result = await sdk().sodax.spoke.deposit({
      srcChainKey: srcChainKey as SpokeChainKey,
      srcAddress: srcAddress as GetAddressType<SpokeChainKey>,
      token: token as GetTokenAddressType<SpokeChainKey>,
      to: to as `0x${string}`,
      amount,
      data: payload as `0x${string}`,
      raw: true,
      // As the EVM rebuild: the Swaps API's own build of this swap already ran the hub simulation.
      skipSimulation: true,
    });
    if (!result.ok) throw new Error("deposit build failed");
    return withSuiSender(srcChainKey, result.value);
  });
}

/**
 * The cancel of a swap from a non-EVM spoke, as the SDK builds its own: a `connection` message from the intent's
 * source address to its creator carrying `cancelIntent(intent)`. Unsigned and raw; fails as a bare error.
 */
export function buildNonEvmCancel(srcChainKey: string, intent: IntentJson): Promise<unknown> {
  return bounded({ label: "cancel build", chainKey: srcChainKey }, async () => {
    const result = await sdk().sodax.swaps.createCancelIntent({
      params: { srcChainKey: srcChainKey as SpokeChainKey, intent: toSdkIntent(intent) },
      raw: true,
    });
    if (!result.ok) throw new Error("cancel build failed");
    return withSuiSender(srcChainKey, result.value);
  });
}

// The SDK leaves a Sui tx's sender unset, so a wallet would sign as whichever account is active: native SUI split
// from that account's gas would pay for the quoted sender's swap.
function withSuiSender(chainKey: string, raw: unknown): unknown {
  if (!isSuiChainKey(chainKey as SpokeChainKey) || !isRecord(raw)) return raw;
  if (typeof raw.from !== "string" || typeof raw.data !== "string") return raw;
  return { ...raw, data: JSON.stringify({ ...JSON.parse(raw.data), sender: raw.from }) };
}

/**
 * Whether a non-EVM build calls what it must where the SDK reads its target from the chain, so an RPC could move
 * it: Solana's programs (from their IDL) must be the packaged ones, Sui's upgraded package the one `expected` (the
 * Swaps API's own build) names. Every other build takes its contract from the packaged config.
 */
export function callsPinnedTarget(
  chainKey: string,
  kind: "swap" | "cancel",
  raw: unknown,
  expected?: unknown,
): boolean {
  const { to, data } = isRecord(raw) ? raw : {};
  const addresses = chainConfigs[chainKey]?.addresses;
  if (isSolanaChainKey(chainKey as SpokeChainKey)) {
    const connection = addresses?.connection;
    if (kind === "cancel") return to === connection;
    // A deposit passes the connection program too, read from the chain as well: the packaged one must be in the tx.
    const passes = (program: unknown) =>
      typeof program === "string" &&
      typeof data === "string" &&
      Buffer.from(data, "base64").includes(Buffer.from(base58Bytes(program)));
    return to === addresses?.assetManager && passes(connection);
  }
  if (isSuiChainKey(chainKey as SpokeChainKey) && kind === "swap") return typeof to === "string" && to === expected;
  return true;
}

/**
 * Whether the relay needs a tx's relay data with it, as the SDK's own relay submit decides: Solana's tx commits
 * only the payload's hash. Bitcoin's too, but it isn't a source here.
 */
export function relayNeedsData(chainKey: string): boolean {
  return isSolanaChainKey(chainKey as SpokeChainKey);
}

/**
 * A non-EVM tx by hash, or `null` while its chain doesn't know it or hasn't run it. Public nodes prune, so a tx
 * days old reads as unknown too. A response the parser doesn't know fails, as any read does, as a bare error:
 * never as a failed tx.
 */
export function readNonEvmTx(
  chainKey: string,
  type: NonEvmSourceType,
  txHash: string,
  sender?: string,
): Promise<NonEvmTx | null> {
  return bounded({ label: "non-EVM tx", chainKey, timeoutMs: RPC_CALL_TIMEOUT_MS }, () =>
    NON_EVM_READERS[type](chainKey, txHash, sender),
  );
}

// One reader per family, through the SDK's one service for that family's chain (see `pinnedSourceOf`).
const NON_EVM_READERS: Record<
  NonEvmSourceType,
  (chainKey: string, txHash: string, sender?: string) => Promise<NonEvmTx | null>
> = {
  async SOLANA(_chainKey, txHash) {
    const tx = await sdk().sodax.spoke.solana.connection.getTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    return solanaTxFrom(tx);
  },
  async STELLAR(_chainKey, txHash) {
    return stellarTxFrom(await sdk().sodax.spoke.stellar.sorobanServer.getTransaction(txHash));
  },
  async SUI(_chainKey, txHash) {
    // The SDK's gRPC client: its transport keeps it private, and only `getTransaction` returns the tx's bytes.
    const { client } = sdk().sodax.spoke.sui.transport as unknown as {
      client: { core: { getTransaction(options: { digest: string; include: { bcs: true } }): Promise<unknown> } };
    };
    try {
      return suiTxFrom(await client.core.getTransaction({ digest: txHash, include: { bcs: true } }));
    } catch (error) {
      // Only the node's own answer names the digest: a 404 from anything in front of it is an outage.
      const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
      if (code === "NOT_FOUND" && typeof message === "string" && message.includes(txHash)) return null;
      throw error;
    }
  },
  async NEAR(chainKey, txHash, sender) {
    // The lookup is routed by the sender's account; public nodes track every shard, so any account does.
    const assetManager = String(chainConfigs[chainKey]?.addresses?.assetManager);
    const accountId = sender ?? assetManager;
    try {
      return nearTxFrom(
        await sdk().sodax.spoke.near.rpcProvider.viewTransactionStatus({ txHash, accountId, waitUntil: "NONE" }),
        assetManager,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "UnknownTransactionError") return null;
      throw error;
    }
  },
  async INJECTIVE(_chainKey, txHash) {
    const url = `${sdk().sodax.spoke.injective.endpoints.rest}/cosmos/tx/v1beta1/txs/${txHash}`;
    // The public LCD balances over nodes that keep different history, so a tx some still have is asked again, as is a
    // slow node. Unknown only if every node said so; each try fits in the read's own bound.
    let slow: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return injectiveTxFrom(await fetchJson<unknown>(url, { timeout: INJECTIVE_TRY_MS }));
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") slow = error;
        else if (!injectiveNodeLacksTx(error)) throw error;
      }
    }
    if (slow) throw slow;
    return null;
  },
};

/**
 * The node's own answer that it doesn't have the tx: NotFound (gRPC code 5), or the block it's in pruned ("height N is
 * not available", code 2). A 404 or 500 from anything in front of the node is an outage.
 */
function injectiveNodeLacksTx(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (error.status === 404) return error.apiCode === 5;
  return error.status === 500 && error.apiCode === 2 && /^height \d+ is not available/.test(error.apiMessage ?? "");
}

/**
 * How a non-EVM tx names the chain's asset manager: as bytes its raw tx holds (Solana's program id, Stellar's
 * contract id, Sui's asset manager object), or as the contract its calls name (NEAR, Injective).
 */
const ASSET_MANAGER_MARKERS: Record<NonEvmSourceType, (assetManager: string) => Uint8Array | string> = {
  NEAR: assetManager => assetManager,
  INJECTIVE: assetManager => assetManager,
  // `<package>::asset_manager::<object>`: the package is upgraded, the shared object stays.
  SUI: assetManager => hexBytes(assetManager.split("::").at(-1) ?? ""),
  SOLANA: assetManager => base58Bytes(assetManager),
  // The contract id: the StrKey's 32 bytes between its version byte and checksum.
  STELLAR: assetManager => base32Bytes(assetManager).subarray(1, 33),
};

/** From the packaged config alone, so the chain support tool answers the same without the SDK loaded. */
export function assetManagerMarker(chainKey: string, type: NonEvmSourceType): Uint8Array | string | undefined {
  const assetManager = chainConfigs[chainKey]?.addresses?.assetManager;
  if (typeof assetManager !== "string") return undefined;
  try {
    return ASSET_MANAGER_MARKERS[type](assetManager);
  } catch {
    return undefined;
  }
}

/**
 * The calls that create `intent`, as the SDK builds them (byte for byte, `intentId` included): what a spoke
 * deposit carries to the user's hub wallet, or from the hub (`hubSource`) the tx's own calldata.
 * `undefined` if the SDK can't.
 */
export function createIntentPayload(intent: IntentJson, hubSource = false): string | undefined {
  try {
    return sdk().sdk.EvmSolverService.reconstructCreateIntentData(
      toSdkIntent(intent),
      solverConfig.intentsContract,
      hubSource,
    );
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
