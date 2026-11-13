/**
 * Solana as a swap source. Its evidence, as the relay's verifier reads it: the connection program's `SendMessage`
 * events in the tx's logs (`Program data:` lines it logged itself), from a tx that succeeded. Its messages carry a
 * payload's keccak only.
 */

import { spokeChainConfig } from "@sodax/types";
import { base58Bytes, isRecord } from "../../../constants.js";
import { spokeClients } from "../../sodax.js";
import { ByteReader, hex } from "./bytes.js";
import { base58Hash, nonEvmAdapter } from "./nonEvm.js";
import type { ConnectionMessage, SpokeEvidence } from "./types.js";

// Anchor's event discriminator, sha256("event:SendMessage")[0..8].
const SEND_MESSAGE_EVENT = "92260ddd57d6f70c";
const DATA_PREFIX = "Program data: ";

/** A program as messages name it: its id's bytes. */
export const solanaSender = (programId: string) => hex(base58Bytes(programId));

type SolanaTx = { meta: { err: unknown; logMessages?: string[] | null } | null } | null;

/**
 * The connection's messages in a tx from `getTransaction`, or `null` until it's confirmed. A failed tx is rolled back
 * whole, so the events it logged first never happened. Truncated logs can't all be read: they throw.
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
    if (log.startsWith("Log truncated")) throw new Error("Solana logs truncated");
    const invoked = /^Program (\S+) invoke \[\d+\]$/.exec(log);
    if (invoked) frames.push(invoked[1]);
    else if (/^Program \S+ (success|failed)/.test(log)) frames.pop();
    else if (log.startsWith(DATA_PREFIX) && frames.at(-1) === connection) {
      const message = sendMessageEvent(Buffer.from(log.slice(DATA_PREFIX.length).trim(), "base64"));
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
  return { srcChainId, srcAddress, dstChainId, dstAddress, payload };
}

export const SOLANA = nonEvmAdapter({
  family: "SOLANA",
  txHash: { format: "a base58 signature", spell: base58Hash(64) },
  commitsHash: true,
  async fetch({ connection, txHash }) {
    const tx = await spokeClients().solana.connection.getTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    return solanaEvidence(tx, connection);
  },
  // The SDK reads the programs from their IDL on chain: a build must call the packaged ones.
  callsPinned(kind, raw) {
    const { to, data } = isRecord(raw) ? raw : {};
    const { assetManager, connection } = spokeChainConfig.solana.addresses;
    if (kind === "cancel") return to === connection;
    // A deposit passes the connection program too, read from the chain as well: the packaged one must be in the tx.
    const passes =
      typeof data === "string" && Buffer.from(data, "base64").includes(Buffer.from(base58Bytes(connection)));
    return to === assetManager && passes;
  },
});
