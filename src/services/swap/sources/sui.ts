/**
 * Sui as a swap source. Its evidence, as the relay's verifier reads it: the connection package's `Message` events, from a tx that
 * succeeded. Read from the event's BCS, whose layout a package upgrade can't change.
 */

import { z } from "zod";
import { isRecord } from "../../../constants.js";
import { spokeClients } from "../../sodax.js";
import { ByteReader, hex, utf8Hex } from "./bytes.js";
import { base58Hash, nonEvmAdapter } from "./nonEvm.js";
import type { ConnectionMessage, SpokeEvidence } from "./types.js";

/** The asset manager as messages name it: the UTF-8 of its config string, `<package>::asset_manager::<object>`. */
export const suiSender = utf8Hex;

const suiTx = z.object({
  status: z.object({ success: z.boolean() }),
  events: z.array(z.object({ eventType: z.string(), bcs: z.instanceof(Uint8Array) })).nullish(),
});
const suiResultSchema = z.union([
  z.object({ $kind: z.literal("Transaction"), Transaction: suiTx }),
  z.object({ $kind: z.literal("FailedTransaction"), FailedTransaction: suiTx }),
]);

// An address in full: events name types with 64 hex digits, a config may drop leading zeros.
const fullAddress = (address: string) => `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

/** The type of `connection`'s messages, from its config string `<package>::<module>::<state object>`. */
const messageType = (connection: string) => {
  const [pkg, module] = connection.split("::");
  return `${fullAddress(pkg)}::${module}::Message`;
};

/**
 * The connection's messages in a tx from `core.getTransaction({ include: { events: true } })`. A failed tx emits no
 * events; a shape it doesn't know throws.
 */
export function suiEvidence(raw: unknown, connection: string): SpokeEvidence {
  const result = suiResultSchema.parse(raw);
  const tx = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  if (result.$kind === "FailedTransaction" || !tx.status.success) return { failed: true, messages: [] };
  if (!tx.events) throw new Error("a Sui tx without its events");
  const type = messageType(connection);
  const messages = tx.events.flatMap(event => {
    const [address, ...rest] = event.eventType.split("::");
    return `${fullAddress(address)}::${rest.join("::")}` === type ? [messageEvent(event.bcs)] : [];
  });
  return { failed: false, messages };
}

/** BCS `Message { u256, vector<u8>, u256 conn_sn, u256, vector<u8>, vector<u8> }`. */
function messageEvent(bcs: Uint8Array): ConnectionMessage {
  const reader = new ByteReader(bcs);
  const bytes = () => hex(reader.take(reader.uleb128()));
  const srcChainId = reader.uintLE(32);
  const srcAddress = bytes();
  reader.uintLE(32);
  const dstChainId = reader.uintLE(32);
  const dstAddress = bytes();
  const payload = bytes();
  if (!reader.done) throw new Error("a Message event of unknown shape");
  return { srcChainId, srcAddress, dstChainId, dstAddress, payload };
}

export const SUI = nonEvmAdapter({
  family: "SUI",
  txHash: { format: "a base58 digest", spell: base58Hash(32) },
  async fetch({ connection, txHash }) {
    try {
      return suiEvidence(
        await suiClient().core.getTransaction({ digest: txHash, include: { events: true } }),
        connection,
      );
    } catch (error) {
      // Only the node's own answer names the digest: a 404 from anything in front of it is an outage.
      const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
      if (code === "NOT_FOUND" && typeof message === "string" && message.includes(txHash)) return null;
      throw error;
    }
  },
  // The SDK reads the upgraded package from the chain: a swap must call the one the Swaps API's own build names.
  callsPinned: (kind, raw, expected) =>
    kind === "cancel" || (isRecord(raw) && typeof raw.to === "string" && raw.to === expected),
  finish: withSender,
});

type SuiGetTransaction = (options: { digest: string; include: { events: true } }) => Promise<unknown>;

/**
 * The SDK's Sui gRPC client, which its transport keeps private: no public SDK call returns a tx's events. Its shape
 * is checked, so an SDK that moves it fails here, plainly, and in the contract tests.
 */
export function suiClient(): { core: { getTransaction: SuiGetTransaction } } {
  const transport = spokeClients().sui.transport as unknown as { client?: { core?: { getTransaction?: unknown } } };
  const client = transport?.client;
  if (typeof client?.core?.getTransaction !== "function") throw new Error("the SDK's Sui client moved");
  return client as { core: { getTransaction: SuiGetTransaction } };
}

// The SDK leaves a Sui tx's sender unset, so a wallet would sign as whichever account is active: native SUI split
// from that account's gas would pay for the quoted sender's swap.
function withSender(raw: unknown): unknown {
  if (!isRecord(raw) || typeof raw.from !== "string" || typeof raw.data !== "string") return raw;
  return { ...raw, data: JSON.stringify({ ...JSON.parse(raw.data), sender: raw.from }) };
}
