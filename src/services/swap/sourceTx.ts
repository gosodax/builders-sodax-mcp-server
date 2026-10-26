/**
 * What a mined source tx proves, from its receipt. A spoke's `connection` contract logs a
 * `Message` for everything it sends to the hub: a deposit (sent by the asset manager) or a
 * cancel (sent by the user). The log only exists if the call happened, which matching the tx
 * input can't show (a batch can succeed while its inner call fails).
 *
 * Small decoders instead of a library: the layouts are fixed, and anything off is refused.
 */

import { HUB_CHAIN_KEY, getIntentRelayChainId } from "@sodax/types";
import { sameHex as same } from "../../constants.js";
import type { EvmReceipt } from "../sodax.js";

/** keccak256("Message(uint256,bytes,uint256,uint256,bytes,bytes)"); nothing is indexed. */
export const MESSAGE_TOPIC = "0x0fcc8c448c97c08d0304a9eb321a5ffb209618d28a85dbc8d7a7a592124538ef";
/** The selector of `connection.sendMessage(uint256 dstChainId, bytes dstAddress, bytes payload)`. */
export const SEND_MESSAGE_SELECTOR = "0x6ea9cec9";
/** The hub's relay id: every message to the hub goes there. */
export const HUB_RELAY_ID = BigInt(getIntentRelayChainId(HUB_CHAIN_KEY));

export interface ConnectionMessage {
  srcChainId: bigint;
  srcAddress: string;
  dstChainId: bigint;
  dstAddress: string;
  payload: string;
}

/** The `Message` logs `connection` emitted in this receipt; an undecodable one is skipped. */
export function connectionMessages(receipt: EvmReceipt, connection: string): ConnectionMessage[] {
  return receipt.logs.flatMap(log => {
    if (!same(log.address, connection) || !same(log.topics[0] ?? "", MESSAGE_TOPIC)) return [];
    const message = decodeMessage(log.data);
    return message ? [message] : [];
  });
}

/** The messages the asset manager sent: deposits, whichever quote they're for. */
export function depositMessages(receipt: EvmReceipt, connection: string, assetManager: string): ConnectionMessage[] {
  return connectionMessages(receipt, connection).filter(message => same(message.srcAddress, assetManager));
}

export type DepositCheck = "match" | "not_a_deposit" | "mismatch";

/**
 * Whether the receipt holds this quote's deposit: a message from the asset manager to the hub
 * whose RLP payload `[token, from, to, amount, data]` sends to the intent's creator and carries
 * the cached relay payload. Amounts aren't compared: the payload's `createIntent` binds them.
 */
export function checkDeposit(
  receipt: EvmReceipt,
  want: { connection: string; assetManager: string; srcChain: string; relayData: { address: string; payload: string } },
): DepositCheck {
  const deposits = depositMessages(receipt, want.connection, want.assetManager);
  if (deposits.length === 0) return "not_a_deposit";
  const matches = deposits.some(message => {
    const items = decodeRlpList(message.payload);
    return (
      message.srcChainId === BigInt(want.srcChain) &&
      message.dstChainId === HUB_RELAY_ID &&
      items?.length === 5 &&
      same(items[2], want.relayData.address) &&
      same(items[4], want.relayData.payload)
    );
  });
  return matches ? "match" : "mismatch";
}

/** Whether the receipt holds the user's cancel: their message to their hub wallet with this payload. */
export function holdsCancel(
  receipt: EvmReceipt,
  want: { connection: string; srcAddress: string; srcChain: string; creator: string; payload: string },
): boolean {
  return connectionMessages(receipt, want.connection).some(
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
