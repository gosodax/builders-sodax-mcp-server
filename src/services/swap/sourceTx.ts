/**
 * What a source tx proves. A spoke's `connection` emits a `Message` for everything it sends to the hub: a deposit
 * (sent by the asset manager) or a cancel (sent by the user). The relay signs exactly those, read from the tx's
 * executed events on every chain, so they are the proof here too; the tx input can't show what ran (a batch can
 * succeed while its inner call fails).
 *
 * Small decoders instead of a library: the layouts are fixed, and anything off is refused.
 */

import { HUB_CHAIN_KEY, getIntentRelayChainId } from "@sodax/types";
import { sameHex as same } from "../../constants.js";
import type { EvmReceipt } from "../sodax.js";
import type { ConnectionMessage } from "./sources/types.js";

/** keccak256("Message(uint256,bytes,uint256,uint256,bytes,bytes)"); nothing is indexed. */
export const MESSAGE_TOPIC = "0x0fcc8c448c97c08d0304a9eb321a5ffb209618d28a85dbc8d7a7a592124538ef";
/** The selector of `connection.sendMessage(uint256 dstChainId, bytes dstAddress, bytes payload)`. */
export const SEND_MESSAGE_SELECTOR = "0x6ea9cec9";
/** keccak256 of the intents contract's `IntentCreated(bytes32,(…intent))`; the hash is the first data word. */
export const INTENT_CREATED_TOPIC = "0x29fecd55cf4a8b6d0aaf6870fbab480f04c3caab050a1af7654278af363cd96f";
/** keccak256("IntentCancelled(bytes32)"); the hash is the data, not indexed. */
export const INTENT_CANCELLED_TOPIC = "0xc08eb64db16a39d2848960af04e3f16fb404d9d436a9f0e9d7d0d4854715c9dc";
/** The hub's relay id: every message to the hub goes there. */
export const HUB_RELAY_ID = BigInt(getIntentRelayChainId(HUB_CHAIN_KEY));

/** The `Message` logs `connection` emitted in this receipt; an undecodable one is skipped. */
export function connectionMessages(receipt: EvmReceipt, connection: string): ConnectionMessage[] {
  return receipt.logs.flatMap(log => {
    if (!same(log.address, connection) || !same(log.topics[0] ?? "", MESSAGE_TOPIC)) return [];
    const message = decodeMessage(log.data);
    return message ? [message] : [];
  });
}

/** The messages the asset manager (as messages name it) sent: deposits, whichever quote they're for. */
export function depositMessages(messages: ConnectionMessage[], assetManager: string): ConnectionMessage[] {
  return messages.filter(message => same(message.srcAddress, assetManager));
}

/**
 * The intent hashes the intents contract logged under `topic` (created or cancelled) in a hub receipt: what a
 * swap or a cancel sent on the hub proves, as a spoke's `connection` message does for a deposit.
 */
export function hubIntentHashes(receipt: EvmReceipt, intentsContract: string, topic: string): string[] {
  return receipt.logs.flatMap(log =>
    same(log.address, intentsContract) && same(log.topics[0] ?? "", topic) && /^0x[0-9a-fA-F]{64}/.test(log.data)
      ? [log.data.slice(0, 66).toLowerCase()]
      : [],
  );
}

export type DepositCheck = "match" | "not_a_deposit" | "mismatch" | "other_sender";

/**
 * Whether the messages hold this quote's deposit: one from the asset manager to the hub whose RLP payload
 * `[token, from, to, amount, data]` comes from the intent's source address, goes to its creator and carries
 * `data`, the relay payload as the chain commits it. Amounts aren't compared: the payload's `createIntent` binds
 * them. Else `other_sender` for that deposit from another address, `mismatch` for the sender's deposit for another
 * intent, `not_a_deposit` for anyone else's (a bundle can hold one).
 */
export function checkDeposit(
  messages: ConnectionMessage[],
  want: { assetManager: string; srcChain: string; srcAddress: string; to: string; data: string },
): DepositCheck {
  const transfers = hubTransfers(messages, want);
  const fromUser = (transfer: Transfer) => same(transfer.from, want.srcAddress);
  const isIntent = (transfer: Transfer) => same(transfer.to, want.to) && same(transfer.data, want.data);
  if (transfers.some(transfer => fromUser(transfer) && isIntent(transfer))) return "match";
  if (transfers.some(isIntent)) return "other_sender";
  return transfers.some(fromUser) ? "mismatch" : "not_a_deposit";
}

interface Transfer {
  from: string;
  to: string;
  data: string;
}

/** The RLP transfers the asset manager sent the hub from `srcChain`; an undecodable one is skipped. */
function hubTransfers(messages: ConnectionMessage[], want: { assetManager: string; srcChain: string }): Transfer[] {
  return depositMessages(messages, want.assetManager).flatMap(message => {
    const items = decodeRlpList(message.payload);
    if (message.srcChainId !== BigInt(want.srcChain) || message.dstChainId !== HUB_RELAY_ID || items?.length !== 5) {
      return [];
    }
    return [{ from: items[1], to: items[2], data: items[4] }];
  });
}

/** Whether the messages hold the user's cancel: theirs to their hub wallet, carrying `payload` as the chain commits it. */
export function holdsCancel(
  messages: ConnectionMessage[],
  want: { srcAddress: string; srcChain: string; creator: string; payload: string },
): boolean {
  return messages.some(
    message =>
      same(message.srcAddress, want.srcAddress) &&
      message.srcChainId === BigInt(want.srcChain) &&
      message.dstChainId === HUB_RELAY_ID &&
      same(message.dstAddress, want.creator) &&
      same(message.payload, want.payload),
  );
}

/** `sendMessage(dstChainId, dstAddress, payload)` calldata, decoded; `undefined` for anything else. */
export function decodeSendMessage(
  data: string,
): { dstChainId: bigint; dstAddress: string; payload: string } | undefined {
  if (!data.toLowerCase().startsWith(SEND_MESSAGE_SELECTOR)) return undefined;
  const args = new AbiReader(data.slice(SEND_MESSAGE_SELECTOR.length));
  const dstChainId = args.word(0);
  const dstAddress = args.bytes(1);
  const payload = args.bytes(2);
  if (dstChainId === undefined || dstAddress === undefined || payload === undefined) return undefined;
  return { dstChainId, dstAddress, payload };
}

/** `Message(srcChainId, srcAddress, connSn, dstChainId, dstAddress, payload)` log data, decoded. */
export function decodeMessage(data: string): ConnectionMessage | undefined {
  const fields = new AbiReader(data.replace(/^0x/, ""));
  const message = {
    srcChainId: fields.word(0),
    srcAddress: fields.bytes(1),
    dstChainId: fields.word(3),
    dstAddress: fields.bytes(4),
    payload: fields.bytes(5),
  };
  return Object.values(message).every(value => value !== undefined) ? (message as ConnectionMessage) : undefined;
}

/** Reads ABI head words and dynamic `bytes` from hex (no `0x`); anything out of bounds is `undefined`. */
class AbiReader {
  private readonly hex: string;

  constructor(hex: string) {
    this.hex = /^(?:[0-9a-fA-F]{64})*$/.test(hex) ? hex.toLowerCase() : "";
  }

  word(index: number): bigint | undefined {
    const text = this.hex.slice(index * 64, (index + 1) * 64);
    return text.length === 64 ? BigInt(`0x${text}`) : undefined;
  }

  bytes(headIndex: number): string | undefined {
    const offset = this.word(headIndex);
    if (offset === undefined || offset % 32n !== 0n || offset * 2n >= BigInt(this.hex.length)) return undefined;
    const start = Number(offset) * 2;
    const length = this.word(start / 64);
    if (length === undefined || BigInt(start + 64) + length * 2n > BigInt(this.hex.length)) return undefined;
    return `0x${this.hex.slice(start + 64, start + 64 + Number(length) * 2)}`;
  }
}

/**
 * A top-level RLP list of byte strings, each as hex. `undefined` for anything else: a nested
 * list, a length field over 4 bytes, an item running past its list, or bytes after the list.
 */
export function decodeRlpList(hex: string): string[] | undefined {
  const body = hex.replace(/^0x/, "");
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(body)) return undefined;
  const bytes = Buffer.from(body, "hex");
  const list = readRlpItem(bytes, 0);
  if (!list?.isList || list.end !== bytes.length) return undefined;
  const items: string[] = [];
  for (let at = list.start; at < list.end; ) {
    const item = readRlpItem(bytes, at);
    if (!item || item.isList || item.end > list.end) return undefined;
    items.push(`0x${bytes.subarray(item.start, item.end).toString("hex")}`);
    at = item.end;
  }
  return items;
}

/** The item at `at`: where its payload starts and ends, and whether it's a list. */
function readRlpItem(bytes: Buffer, at: number): { isList: boolean; start: number; end: number } | undefined {
  const prefix = bytes[at];
  if (prefix === undefined) return undefined;
  if (prefix < 0x80) return { isList: false, start: at, end: at + 1 };
  const isList = prefix >= 0xc0;
  const base = isList ? 0xc0 : 0x80;
  let start = at + 1;
  let length = prefix - base;
  if (length > 55) {
    const lengthBytes = length - 55;
    if (lengthBytes > 4 || start + lengthBytes > bytes.length) return undefined;
    length = bytes.readUIntBE(start, lengthBytes);
    start += lengthBytes;
  }
  const end = start + length;
  return end <= bytes.length ? { isList, start, end } : undefined;
}
