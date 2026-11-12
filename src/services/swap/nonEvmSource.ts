/**
 * What a swap from a non-EVM spoke needs beyond the EVM path: its tx hash format, the step its wallet signs, and
 * the check that a tx is the quoted swap. Checked on real deposits of each family.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes } from "@noble/hashes/utils";
import { z } from "zod";
import { BASE58, BASE58_64_BYTES, EVM_TX_HASH_PATTERN, HEX_64, base58Bytes, isRecord } from "../../constants.js";
import type { NonEvmSourceType } from "../sodax.js";
import { ActionError } from "./errors.js";

/** A non-EVM tx as its chain returns it. */
export interface NonEvmTx {
  failed: boolean;
  /** The tx as signed: Solana's message, Stellar's envelope XDR, Sui's transaction BCS. Empty for NEAR and Injective. */
  bytes: Uint8Array;
  /** NEAR's function calls (an `ft_transfer_call`'s `msg` as its own) and Injective's contract executions. */
  calls: { contract: string; args: unknown }[];
  /** NEAR's signer, a meta-transaction's sender: only a NEAR wallet picks the account, so only there can it differ. */
  signer?: string;
}

const BASE58_32_BYTES = new RegExp(`^[${BASE58}]{32,44}$`);
// The length alone lets through text that decodes to another size, which a node refuses as an error, not as unknown.
const base58 = (pattern: RegExp, size: number) => (text: string) =>
  pattern.test(text) && base58Bytes(text).length === size ? text : undefined;

/**
 * Each family's tx hash: how it looks, for the error that refuses another, and how its chain spells it, since the
 * backend keys a swap on the exact string.
 */
const TX_HASHES: Record<"EVM" | NonEvmSourceType, { format: string; spell: (text: string) => string | undefined }> = {
  EVM: {
    format: "0x and 64 hex characters",
    spell: text => (EVM_TX_HASH_PATTERN.test(text) ? text.toLowerCase() : undefined),
  },
  STELLAR: { format: "64 hex characters", spell: text => HEX_64.exec(text)?.[1].toLowerCase() },
  INJECTIVE: { format: "64 hex characters", spell: text => HEX_64.exec(text)?.[1].toUpperCase() },
  NEAR: { format: "a base58 hash", spell: base58(BASE58_32_BYTES, 32) },
  SUI: { format: "a base58 digest", spell: base58(BASE58_32_BYTES, 32) },
  SOLANA: { format: "a base58 signature", spell: base58(BASE58_64_BYTES, 64) },
};

/** A tx hash as its chain spells it, or `undefined` if it can't be one of the family's. */
export const normalizeTxHash = (family: "EVM" | NonEvmSourceType, value: string) =>
  TX_HASHES[family].spell(value.trim());
export const txHashFormat = (family: "EVM" | NonEvmSourceType) => TX_HASHES[family].format;

/** Whether the value can be some source family's tx hash, for the tool argument; its chain's own rule comes later. */
export const isAnyTxHash = (value: string) =>
  Object.values(TX_HASHES).some(({ spell }) => spell(value.trim()) !== undefined);

/** Throws on anything but whole hex bytes, rather than drop what follows a bad character. */
export const hexBytes = (hex: string) => hexToBytes(hex.replace(/^0x/, ""));
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const contains = (haystack: Uint8Array, needle: Uint8Array) =>
  needle.length > 0 && asBuffer(haystack).indexOf(asBuffer(needle)) !== -1;

/** Whether a JSON value holds `bytes` as an array of numbers, at most a few levels down. */
function holdsBytes(value: unknown, bytes: Uint8Array, depth = 4): boolean {
  if (Array.isArray(value)) {
    if (value.length === bytes.length && value.every((byte, i) => byte === bytes[i])) return true;
  }
  if (depth === 0 || typeof value !== "object" || value === null) return false;
  return Object.values(value).some(child => holdsBytes(child, bytes, depth - 1));
}

/**
 * Whether the tx carries `payload` (hex), the relay data its quote or cancel holds, in the form its family's relay
 * reads: its bytes in the signed tx (Stellar, Sui), a JSON byte array in a call's arguments (NEAR, Injective), or
 * only its keccak (Solana).
 */
export function carriesPayload(tx: NonEvmTx, payload: string, family: NonEvmSourceType): boolean {
  const bytes = hexBytes(payload);
  // Solana's tx commits only the hash: the relay takes the payload from the submit and checks it against that.
  if (family === "SOLANA") return contains(tx.bytes, keccak_256(bytes));
  return contains(tx.bytes, bytes) || tx.calls.some(call => holdsBytes(call.args, bytes));
}

/** Whether the tx touches the chain's asset manager (`assetManagerMarker`): a deposit, or at least a try at one. */
export function callsAssetManager(tx: NonEvmTx, marker: Uint8Array | string): boolean {
  return typeof marker === "string" ? tx.calls.some(call => call.contract === marker) : contains(tx.bytes, marker);
}

// NEAR's stages before every receipt has run.
const NEAR_IN_FLIGHT = ["NONE", "INCLUDED", "INCLUDED_FINAL"];
const NEAR_EXECUTED = ["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"];

// A tx still in flight comes back with its stage and little else.
const nearStageSchema = z.object({ final_execution_status: z.string().optional() });
const nearOutcomeSchema = z.object({
  transaction: z.object({ signer_id: z.string().optional(), receiver_id: z.string(), actions: z.array(z.unknown()) }),
  transaction_outcome: z.object({ outcome: z.object({ status: z.unknown(), receipt_ids: z.array(z.string()) }) }),
  receipts_outcome: z.array(
    z.object({
      id: z.string(),
      outcome: z.object({
        status: z.unknown(),
        executor_id: z.string().optional(),
        receipt_ids: z.array(z.string()).optional(),
      }),
    }),
  ),
});
type NearReceipt = z.infer<typeof nearOutcomeSchema>["receipts_outcome"][number];

const injectiveTxSchema = z.object({
  tx: z.object({
    body: z.object({
      messages: z.array(z.object({ "@type": z.string(), contract: z.string().optional(), msg: z.unknown() })),
    }),
  }),
  tx_response: z.object({ code: z.number() }),
});

const suiTx = z.object({ status: z.object({ success: z.boolean() }), bcs: z.instanceof(Uint8Array) });
const suiResultSchema = z.union([
  z.object({ $kind: z.literal("Transaction"), Transaction: suiTx }),
  z.object({ $kind: z.literal("FailedTransaction"), FailedTransaction: suiTx }),
]);

const isFailure = (status: unknown) => isRecord(status) && "Failure" in status;

/** JSON text, or `undefined` if it isn't JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type NearAction = {
  FunctionCall?: { method_name?: unknown; args?: unknown };
  // A meta-transaction: a relayer sends the user's signed actions on to `receiver_id`.
  Delegate?: { delegate_action?: { sender_id?: unknown; receiver_id?: unknown; actions?: unknown } };
} | null;

/**
 * A NEAR tx's function calls, each with its decoded JSON args, a relayed meta-transaction's included; an
 * `ft_transfer_call` adds its `msg` as a call to the token's receiver.
 */
function nearCalls(receiverId: string, actions: unknown[]): NonEvmTx["calls"] {
  const calls: NonEvmTx["calls"] = [];
  for (const action of actions as NearAction[]) {
    const delegated = action?.Delegate?.delegate_action;
    if (typeof delegated?.receiver_id === "string" && Array.isArray(delegated.actions)) {
      calls.push(...nearCalls(delegated.receiver_id, delegated.actions));
    }
    const call = action?.FunctionCall;
    if (typeof call?.args !== "string") continue;
    const args = parseJson(Buffer.from(call.args, "base64").toString("utf8"));
    calls.push({ contract: receiverId, args });
    const { receiver_id: to, msg } = (args ?? {}) as { receiver_id?: unknown; msg?: unknown };
    if (call.method_name === "ft_transfer_call" && typeof to === "string" && typeof msg === "string") {
      calls.push({ contract: to, args: parseJson(msg) });
    }
  }
  return calls;
}

/** The first receipt `assetManager` ran, following the tx's receipts from `firstId`: the deposit itself. */
function depositReceipt(receipts: NearReceipt[], firstId: string, assetManager: string): NearReceipt | undefined {
  const byId = new Map(receipts.map(receipt => [receipt.id, receipt]));
  const queue = [firstId];
  for (let i = 0; i < queue.length && i <= receipts.length; i++) {
    const receipt = byId.get(queue[i]);
    if (receipt?.outcome.executor_id === assetManager) return receipt;
    queue.push(...(receipt?.outcome.receipt_ids ?? []));
  }
  return undefined;
}

/**
 * A NEAR tx from its JSON-RPC outcome, or `null` until every receipt has run. A shape it doesn't know throws.
 * Failed only if the tx, its first call or the asset manager's receipt of the deposit failed, which moves nothing
 * (a token's `ft_resolve_transfer` refunds a rejected `ft_on_transfer`). NEAR doesn't roll back a later receipt's
 * failure across contracts, so whether such a deposit went through is the relay's to judge, never "send it again".
 */
export function nearTxFrom(raw: unknown, assetManager?: string): NonEvmTx | null {
  const stage = nearStageSchema.parse(raw).final_execution_status;
  if (stage !== undefined && NEAR_IN_FLIGHT.includes(stage)) return null;
  if (stage !== undefined && !NEAR_EXECUTED.includes(stage)) throw new Error("unknown NEAR tx stage");
  const { transaction, transaction_outcome, receipts_outcome } = nearOutcomeSchema.parse(raw);
  const [firstCall] = transaction_outcome.outcome.receipt_ids;
  const first = receipts_outcome.find(receipt => receipt.id === firstCall);
  const calls = nearCalls(transaction.receiver_id, transaction.actions);
  const deposit = assetManager && firstCall ? depositReceipt(receipts_outcome, firstCall, assetManager) : undefined;
  // Sent to the asset manager, yet it never ran (a meta-transaction's inner call failed first): nothing moved. Only
  // where the RPC names each receipt's executor, as it does.
  const traced = receipts_outcome.some(receipt => receipt.outcome.executor_id !== undefined);
  const neverRan = traced && deposit === undefined && calls.some(call => call.contract === assetManager);
  const failed =
    isFailure(transaction_outcome.outcome.status) ||
    isFailure(first?.outcome.status) ||
    isFailure(deposit?.outcome.status) ||
    neverRan;
  const delegated = (transaction.actions as NearAction[]).find(action => action?.Delegate)?.Delegate?.delegate_action;
  const signer = typeof delegated?.sender_id === "string" ? delegated.sender_id : transaction.signer_id;
  return { failed, bytes: new Uint8Array(), calls, ...(signer !== undefined && { signer }) };
}

// The SDK builds the first; Injective's EIP-712 wallets send the second, whose msg is JSON text.
const INJECTIVE_EXECUTES = ["/cosmwasm.wasm.v1.MsgExecuteContract", "/injective.wasmx.v1.MsgExecuteContractCompat"];

/** An Injective tx from the chain's REST `GET /cosmos/tx/v1beta1/txs/{hash}`: its contract executions. */
export function injectiveTxFrom(body: unknown): NonEvmTx {
  const { tx, tx_response } = injectiveTxSchema.parse(body);
  const calls = tx.body.messages
    .filter(message => INJECTIVE_EXECUTES.includes(message["@type"]) && message.contract)
    .map(({ contract, msg }) => ({ contract: String(contract), args: typeof msg === "string" ? parseJson(msg) : msg }));
  return { failed: tx_response.code !== 0, bytes: new Uint8Array(), calls };
}

/** A Solana tx from `connection.getTransaction`, or `null` until it's confirmed. */
export function solanaTxFrom(
  tx: { meta: { err: unknown } | null; transaction: { message: { serialize(): Uint8Array } } } | null,
): NonEvmTx | null {
  if (!tx?.meta) return null;
  return { failed: tx.meta.err !== null, bytes: tx.transaction.message.serialize(), calls: [] };
}

/**
 * A Stellar tx from Soroban's `getTransaction`, or `null` while it's unknown. A status it doesn't know throws. Its
 * client returns the envelope as base64, though the stellar-sdk type says an XDR object.
 */
export function stellarTxFrom(result: { status: string; envelopeXdr?: unknown }): NonEvmTx | null {
  if (result.status === "NOT_FOUND") return null;
  if (result.status !== "SUCCESS" && result.status !== "FAILED") throw new Error("unknown Stellar tx status");
  const envelope = result.envelopeXdr;
  const bytes =
    typeof envelope === "string" ? Buffer.from(envelope, "base64") : (envelope as { toXDR(): Buffer }).toXDR();
  return { failed: result.status === "FAILED", bytes, calls: [] };
}

/** A Sui tx from `@mysten/sui`'s `core.getTransaction({ include: { bcs: true } })`. A shape it doesn't know throws. */
export function suiTxFrom(raw: unknown): NonEvmTx {
  const result = suiResultSchema.parse(raw);
  const tx = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  return { failed: result.$kind === "FailedTransaction" || !tx.status.success, bytes: tx.bcs, calls: [] };
}

/** A non-EVM step: the SDK's unsigned raw tx for the family's wallets, as JSON (`jsonSafe`). */
export interface NonEvmStep {
  kind: "swap" | "cancel";
  chainKey: string;
  chainType: NonEvmSourceType;
  tx: unknown;
}

/**
 * The SDK's raw tx as JSON, its shape kept: bigints as decimal strings, bytes as base64. The signing hints name
 * its fields, which the contract tests check on live builds.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

export function toNonEvmStep(
  kind: NonEvmStep["kind"],
  family: NonEvmSourceType,
  chainKey: string,
  raw: unknown,
): NonEvmStep {
  if (!isRecord(raw)) {
    throw new ActionError("INTERNAL", "The SDK built a transaction this server doesn't recognize.");
  }
  return { kind, chainKey, chainType: family, tx: jsonSafe(raw) };
}
