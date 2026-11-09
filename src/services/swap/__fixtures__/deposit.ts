/**
 * The recorded Arbitrum deposit (public chain data), the addresses around it, and a builder for
 * receipts holding one `connection` Message. Not built.
 */

import { readFileSync } from "node:fs";
import type { EvmReceipt } from "../../sodax.js";
import { MESSAGE_TOPIC, decodeMessage, decodeRlpList } from "../sourceTx.js";
import { abiEncode } from "./encode.js";

export const CONNECTION = "0x4555aC13D7338D9E671584C1D118c06B2a3C88eD";
export const ASSET_MANAGER = "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3";
/** The user: the recorded deposit's sender. */
export const USER = "0x67efb0c797e5586e6d5ff80714c1dd64ba84be0b";
export const CREATOR = `0x${"c".repeat(40)}`;

const raw = JSON.parse(readFileSync(new URL("./arbitrum-deposit-receipt.json", import.meta.url), "utf8")) as {
  transactionHash: string;
  status: string;
  logs: EvmReceipt["logs"];
};
export const DEPOSIT_TX = raw.transactionHash;
/** One `Message` from Arbitrum's asset manager to the hub, and nothing else. */
export const DEPOSIT_RECEIPT: EvmReceipt = { reverted: raw.status !== "0x1", logs: raw.logs };
export const DEPOSIT_MESSAGE = decodeMessage(raw.logs[0].data);
const items = decodeRlpList(DEPOSIT_MESSAGE?.payload ?? "") ?? [];
/** What the quote cached for this deposit: the relay sends the payload to the creator's hub wallet. */
export const DEPOSIT_RELAY_DATA = { address: items[2], payload: items[4] };

/** A receipt with one Message from `address`; the defaults are a deposit from the asset manager to the hub. */
export function messageReceipt(
  message: { srcChainId?: bigint; srcAddress?: string; dstChainId?: bigint; dstAddress?: string; payload: string },
  address = CONNECTION,
): EvmReceipt {
  const data = abiEncode([
    message.srcChainId ?? 23n,
    message.srcAddress ?? ASSET_MANAGER,
    1n,
    message.dstChainId ?? 146n,
    message.dstAddress ?? CREATOR,
    message.payload,
  ]);
  return { reverted: false, logs: [{ address, topics: [MESSAGE_TOPIC], data }] };
}
