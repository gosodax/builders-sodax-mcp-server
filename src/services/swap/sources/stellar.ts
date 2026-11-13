/**
 * Stellar as a swap source. Its evidence, as the relay's verifier reads it: the connection contract's `Message` events in Soroban's
 * `getTransaction` (`events.contractEventsXdr`), from a tx that succeeded. A small XDR reader for those events only:
 * another contract's events are skipped by id, and a value type the connection doesn't emit is refused.
 */

import { HEX_64, base32Bytes } from "../../../constants.js";
import { spokeClients } from "../../sodax.js";
import { ActionError } from "../errors.js";
import { ByteReader, hex } from "./bytes.js";
import { nonEvmAdapter } from "./nonEvm.js";
import type { ConnectionMessage, SpokeEvidence } from "./types.js";

/** A contract's 32-byte id, from its strkey (`C…`: a version byte, the id, a checksum). */
export function stellarContractId(strkey: string): Uint8Array {
  const bytes = base32Bytes(strkey);
  if (!strkey.startsWith("C") || bytes.length !== 35) throw new Error("not a Stellar contract");
  return bytes.subarray(1, 33);
}

/** A contract as messages name it: its address as an `ScVal` (type 18, contract 1) in XDR. */
export const stellarSender = (strkey: string) => `0x0000001200000001${hex(stellarContractId(strkey)).slice(2)}`;

type StellarResult = { status: string; events?: { contractEventsXdr?: unknown } };

/** The connection's messages in a tx, or `null` while the node doesn't know it. A status it doesn't know throws. */
export function stellarEvidence(result: StellarResult, connection: string): SpokeEvidence | null {
  if (result.status === "NOT_FOUND") return null;
  // A failed tx emits no contract events.
  if (result.status === "FAILED") return { failed: true, messages: [] };
  if (result.status !== "SUCCESS") throw new Error("unknown Stellar tx status");
  const perOperation = result.events?.contractEventsXdr;
  if (!Array.isArray(perOperation)) throw new Error("a Stellar tx without its events");
  const id = Buffer.from(stellarContractId(connection));
  const messages = perOperation.flat().flatMap(event => {
    const message = connectionMessage(eventBytes(event), id);
    return message ? [message] : [];
  });
  return { failed: false, messages };
}

// Its RPC client returns the XDR as base64, though the stellar-sdk type says an XDR object.
function eventBytes(event: unknown): Uint8Array {
  if (typeof event === "string") return Buffer.from(event, "base64");
  const xdr = event as { toXDR?: () => Uint8Array } | null;
  if (typeof xdr?.toXDR !== "function") throw new Error("a Stellar event of unknown shape");
  return xdr.toXDR();
}

/** `ContractEvent { ext, contractID*, type, v0 { topics, data } }`: the connection's `Message`, else `undefined`. */
function connectionMessage(event: Uint8Array, connection: Buffer): ConnectionMessage | undefined {
  const reader = new ByteReader(event);
  if (reader.uintBE32() !== 0) throw new Error("unknown event extension");
  if (reader.uintBE32() !== 1) return undefined;
  if (!connection.equals(reader.take(32))) return undefined;
  // CONTRACT: the only type a contract emits; then body v0.
  if (reader.uintBE32() !== 1 || reader.uintBE32() !== 0) return undefined;
  const topics = Array.from({ length: reader.count(4) }, () => scVal(reader));
  const [topic] = topics;
  if (topics.length !== 1 || (topic.type !== "string" && topic.type !== "symbol") || topic.value !== "Message") {
    return undefined;
  }
  const data = scVal(reader);
  if (!reader.done || data.type !== "map") throw new Error("a Message event of unknown shape");
  const field = (name: string) => data.value.find(([key]) => key.type === "symbol" && key.value === name)?.[1];
  const u128 = (name: string) => {
    const value = field(name);
    if (value?.type !== "u128") throw new Error("a Message event of unknown shape");
    return value.value;
  };
  const bytes = (name: string) => {
    const value = field(name);
    if (value?.type !== "bytes") throw new Error("a Message event of unknown shape");
    return hex(value.value);
  };
  return {
    srcChainId: u128("src_chain_id"),
    srcAddress: bytes("src_address"),
    dstChainId: u128("dst_chain_id"),
    dstAddress: bytes("dst_address"),
    payload: bytes("payload"),
  };
}

type ScVal =
  | { type: "u128"; value: bigint }
  | { type: "bytes"; value: Uint8Array }
  | { type: "string" | "symbol"; value: string }
  | { type: "map"; value: [ScVal, ScVal][] };

/** The `ScVal`s the connection's `Message` holds; any other type throws. */
function scVal(reader: ByteReader): ScVal {
  const type = reader.uintBE32();
  const opaque = () => {
    const length = reader.uintBE32();
    const value = reader.take(length);
    reader.take((4 - (length % 4)) % 4);
    return value;
  };
  switch (type) {
    case 9:
      return { type: "u128", value: (reader.uintBE(8) << 64n) + reader.uintBE(8) };
    case 13:
      return { type: "bytes", value: opaque() };
    case 14:
    case 15:
      return { type: type === 14 ? "string" : "symbol", value: Buffer.from(opaque()).toString("utf8") };
    case 17: {
      if (reader.uintBE32() !== 1) throw new Error("an empty map");
      const entries = Array.from({ length: reader.count(8) }, (): [ScVal, ScVal] => [scVal(reader), scVal(reader)]);
      return { type: "map", value: entries };
    }
    default:
      throw new Error("an ScVal type the connection doesn't emit");
  }
}

export const STELLAR = nonEvmAdapter({
  family: "STELLAR",
  txHash: { format: "64 hex characters", spell: text => HEX_64.exec(text)?.[1].toLowerCase() },
  async fetch({ connection, txHash }) {
    return stellarEvidence(await spokeClients().stellar.sorobanServer.getTransaction(txHash), connection);
  },
  // Its only approval is trustline room, which this server doesn't build.
  notApproved: symbol =>
    new ActionError("SWAP_REJECTED", `The wallet's ${symbol} trustline has too little room for this amount.`, {
      nextStep: `Tell the user their Stellar wallet must raise its ${symbol} trustline limit by the amount sent, then quote again.`,
    }),
});
