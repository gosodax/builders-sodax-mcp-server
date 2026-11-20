/**
 * Solana as a swap source. Its evidence, as the relay's verifier reads it: the connection program's `SendMessage`
 * events in the tx's logs (`Program data:` lines it logged itself), from a tx that succeeded. Its messages carry a
 * payload's keccak only.
 */

import { spokeChainConfig } from "@sodax/types";
import { base58Bytes, isRecord } from "../../../constants.js";
import { spokeClients } from "../../sodax.js";
import { ByteReader, hex } from "./bytes.js";
import { UnreadableEvents, base58Hash, nonEvmAdapter, readable } from "./nonEvm.js";
import type { ConnectionMessage, SpokeEvidence } from "./types.js";

// Anchor's event discriminator, sha256("event:SendMessage")[0..8].
const SEND_MESSAGE_EVENT = "92260ddd57d6f70c";
const DATA_PREFIX = "Program data: ";

/** A program as messages name it: its id's bytes. */
export const solanaSender = (programId: string) => hex(base58Bytes(programId));

type SolanaTx = { meta: { err: unknown; logMessages?: string[] | null } | null } | null;

/**
 * The connection's messages in a tx from `getTransaction`, or `null` until it's confirmed. A failed tx is rolled back
 * whole, so the events it logged first never happened. Truncated logs can't all be read: such a tx is unreadable.
 */
export function solanaEvidence(tx: SolanaTx, connection: string): SpokeEvidence | null {
  if (!tx?.meta) return null;
  if (tx.meta.err) return { failed: true, messages: [] };
  const logs = tx.meta.logMessages;
  if (!Array.isArray(logs)) throw new Error("a Solana tx without its logs");
  // The programs running, innermost last: a `Program data:` line names no program, so only the frame tells who logged it.
  const frames: string[] = [];
  const messages: ConnectionMessage[] = [];
  for (const log of logs) {
    if (log.startsWith("Log truncated")) throw new UnreadableEvents("Solana logs truncated");
    // Don't tighten this alone: it must attribute events as the relay does, or a deposit could be claimed unrelayed.
    const invoked = /^Program (\S+) invoke \[\d+\]$/.exec(log);
    if (invoked) frames.push(invoked[1]);
    else if (/^Program \S+ (success|failed)/.test(log)) frames.pop();
    else if (log.startsWith(DATA_PREFIX) && frames.at(-1) === connection) {
      const message = readable(() => sendMessageEvent(Buffer.from(log.slice(DATA_PREFIX.length).trim(), "base64")));
      if (message) messages.push(message);
    }
  }
  return { failed: false, messages };
}

/** Borsh `SendMessage { u128, vec, u128 conn_sn, u128, vec, vec }`; another of its events is `undefined`. */
function sendMessageEvent(data: Buffer): ConnectionMessage | undefined {
  if (data.subarray(0, 8).toString("hex") !== SEND_MESSAGE_EVENT) return undefined;
  const reader = new ByteReader(data, 8);
  const srcChainId = reader.uintLE(16);
  const srcAddress = hex(reader.take(reader.uintLE32()));
  reader.uintLE(16);
  const dstChainId = reader.uintLE(16);
  const dstAddress = hex(reader.take(reader.uintLE32()));
  const payload = hex(reader.take(reader.uintLE32()));
  // Bytes past these (a field a later connection appends) don't change them; a layout that moves them can't match a
  // quote's deposit. So they're not refused, which would only stop every Solana swap the relay still carries.
  return { srcChainId, srcAddress, dstChainId, dstAddress, payload };
}

const COMPUTE_BUDGET = solanaSender("ComputeBudget111111111111111111111111111111");

/**
 * The calls in an unsigned v0 tx, as the wallet signs it: each instruction's program and accounts, as `0x` hex ids.
 * A legacy tx, one that loads accounts from a lookup table, or any other shape throws.
 */
export function solanaCalls(tx: Uint8Array): { program: string; accounts: string[] }[] {
  // Read in loops, so a bad length runs out of bytes, not memory.
  const reader = new ByteReader(tx);
  reader.take(64 * reader.uleb128());
  if (reader.take(1)[0] !== 0x80) throw new Error("not a v0 Solana message");
  reader.take(3);
  const keys: string[] = [];
  for (let count = reader.uleb128(); count > 0; count--) keys.push(hex(reader.take(32)));
  const key = (index: number) => {
    const id = keys[index];
    if (id === undefined) throw new Error("an account outside the Solana message");
    return id;
  };
  reader.take(32);
  const calls: { program: string; accounts: string[] }[] = [];
  for (let count = reader.uleb128(); count > 0; count--) {
    const program = key(reader.take(1)[0]);
    const accounts = [...reader.take(reader.uleb128())].map(key);
    reader.take(reader.uleb128());
    calls.push({ program, accounts });
  }
  if (reader.uleb128() !== 0 || !reader.done) throw new Error("a Solana message with lookups or trailing bytes");
  return calls;
}

export const SOLANA = nonEvmAdapter({
  family: "SOLANA",
  txHash: { format: "a base58 signature", spell: base58Hash(64) },
  commitsHash: true,
  async fetch({ connection, txHash }) {
    const tx = await spokeClients().solana.connection.getTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
      commitment: "finalized",
    });
    return solanaEvidence(tx, connection);
  },
  // A tx is read once finalized, some 13 s after it's processed: any status means its node has it.
  async seen({ txHash }) {
    const { value } = await spokeClients().solana.connection.getSignatureStatuses([txHash]);
    return value[0] != null;
  },
  // The SDK takes the programs from their IDL on chain, so the bytes the wallet signs are checked, not the SDK's `to`:
  // besides the compute budget, one call, to the packaged program. A deposit names the connection it calls too.
  callsPinned(kind, raw) {
    const { data } = isRecord(raw) ? raw : {};
    if (typeof data !== "string") return false;
    const { assetManager, connection } = spokeChainConfig.solana.addresses;
    let calls: ReturnType<typeof solanaCalls>;
    try {
      calls = solanaCalls(Buffer.from(data, "base64")).filter(call => call.program !== COMPUTE_BUDGET);
    } catch {
      return false;
    }
    if (calls.length !== 1) return false;
    const [{ program, accounts }] = calls;
    if (kind === "cancel") return program === solanaSender(connection);
    return program === solanaSender(assetManager) && accounts.includes(solanaSender(connection));
  },
});
