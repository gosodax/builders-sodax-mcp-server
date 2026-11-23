/**
 * Whether a filled swap's tokens reached its destination chain: the relay's packets of the hub fill tx, read once.
 * Only one packet is this swap's delivery, and only its execution on the destination counts as arrived.
 */

import { type SpokeChainKey, hubConfig, isBitcoinChainKey, isInjectiveChainKey, solverConfig } from "@sodax/types";
import { z } from "zod";
import { sameHex as same } from "../../constants.js";
import type { RelayPacketsResponse } from "../../types.js";
import { errorName, logger } from "../logger.js";
import { getRelayTransactionPackets } from "../relay.js";
import type { Delivered } from "./quoteCache.js";
import { HUB_RELAY_ID, decodeTransfer } from "./sourceTx.js";
import { isAnyTxHash } from "./sources/index.js";
import type { Intent } from "./swapsApi.js";

// Track waits on a fill within one tool call: a slow relay reads as not delivered yet, and the next call asks again.
const DELIVERY_READ_TIMEOUT_MS = 5_000;
const HUB_CHAIN_ID = HUB_RELAY_ID.toString();
// The relay spells a packet's sender as bare hex.
const HUB_ASSET_MANAGER = hubConfig.addresses.assetManager.slice(2);

// Only what the check reads; an in-flight packet may have no destination hash yet.
const packetsSchema = z.array(
  z.object({
    src_chain_id: z.number(),
    src_tx_hash: z.string(),
    src_address: z.string(),
    status: z.string(),
    dst_chain_id: z.number(),
    dst_tx_hash: z.string().nullish(),
    payload: z.string(),
  }),
);
type Packet = z.infer<typeof packetsSchema>[number];

/**
 * The destination tx of this swap's one packet, once executed and spelled as some chain family spells a hash.
 * `undefined` is still in transit: a relay that fails, doesn't know the fill yet, or answers anything else.
 */
export async function readDelivery(
  fillTxHash: string,
  intent: Pick<Intent, "dstChain" | "dstAddress">,
): Promise<string | undefined> {
  let response: RelayPacketsResponse;
  try {
    response = await getRelayTransactionPackets(
      { chain_id: HUB_CHAIN_ID, tx_hash: fillTxHash },
      DELIVERY_READ_TIMEOUT_MS,
    );
  } catch (error) {
    // The relay client wraps every failure in a plain Error: its cause says what failed.
    const failure = error instanceof Error ? (error.cause ?? error) : error;
    logger.warn({ "tx.hash": fillTxHash, "error.type": errorName(failure) }, "Relay packets of a swap fill unread");
    return undefined;
  }
  // The relay answers a tx it hasn't indexed yet with `success: false`.
  if (!response.success) return undefined;
  const packets = packetsSchema.safeParse(response.data);
  if (!packets.success) {
    logger.warn({ "tx.hash": fillTxHash }, "Unexpected relay packets of a swap fill");
    return undefined;
  }
  const ours = packets.data.filter(packet => isDelivery(packet, fillTxHash, intent));
  // None is a fill the relay hasn't seen whole; two can't tell which one is the user's.
  if (ours.length !== 1) return undefined;
  const [packet] = ours;
  const dstTxHash = packet.dst_tx_hash?.trim() ?? "";
  return packet.status === "executed" && isAnyTxHash(dstTxHash) ? dstTxHash : undefined;
}

/**
 * What an executed packet proves on the destination: that the tokens arrived, except on Bitcoin and Injective, where
 * the relay marks it executed once it has sent the destination tx, before that chain has run it.
 */
export function deliveryProof(dstChainKey: string): Delivered["delivery"] {
  const key = dstChainKey as SpokeChainKey;
  return isBitcoinChainKey(key) || isInjectiveChainKey(key) ? "sent" : "delivered";
}

/**
 * A fill can send other transfers to the same chain in the same tx: the intent's delivery is the one the intents
 * contract sends to its recipient (payload items: token, sender, recipient, amount, data), through the hub asset
 * manager, the only sender whose payload names the contract that called it.
 */
function isDelivery(packet: Packet, fillTxHash: string, intent: Pick<Intent, "dstChain" | "dstAddress">): boolean {
  if (String(packet.src_chain_id) !== HUB_CHAIN_ID || !same(packet.src_tx_hash, fillTxHash)) return false;
  if (!same(packet.src_address.replace(/^0x/, ""), HUB_ASSET_MANAGER)) return false;
  if (String(packet.dst_chain_id) !== intent.dstChain) return false;
  const transfer = decodeTransfer(packet.payload);
  return (
    transfer !== undefined && same(transfer.from, solverConfig.intentsContract) && same(transfer.to, intent.dstAddress)
  );
}
