/**
 * `sodax_bridge_submit_and_track`: a sent bridge checked on its source chain against its build, submitted once, then
 * followed to the hub and on. Track trusts only the build kept here and the chains (ADR 0001): a backend row is read
 * for its progress, never as proof that a tx is this bridge's deposit.
 *
 * Without the build (a restart, or 40 minutes past prepare), a bridge the backend already has is still followed; one it
 * hasn't is left to the operator, as the swap tools do with a deposit whose quote is gone. Track runs right after the
 * wallet broadcasts, so that's a bridge signed and never tracked in time.
 */

import { HUB_CHAIN_KEY, hubConfig, isBitcoinChainKey, isInjectiveChainKey } from "@sodax/types";
import { sameHex as same } from "../../constants.js";
import { callerKeyHash } from "../requestContext.js";
import {
  type RelayPacket,
  encodeRecipient,
  getEvmReceipt,
  getHubTx,
  hubHookFailed,
  intentChainId,
  isHubChain,
  relayPackets,
} from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { alertOperator } from "../swap/alerts.js";
import { ActionError } from "../swap/errors.js";
import { resolveSwapChain, toChain } from "../swap/resolver.js";
import {
  chainRead,
  committedPayload,
  readSourceTx,
  seenOnChain,
  sourceChainFor,
  sourceTxHash,
} from "../swap/source.js";
import { HUB_RELAY_ID, checkDeposit, decodeRlpList } from "../swap/sourceTx.js";
import type { SwapSource } from "../swap/sources/types.js";
import { type BridgeTxStatus, getBridgeTxStatus, submitBridgeTx } from "./bridgeApi.js";
import { getBridgeCatalog } from "./catalog.js";
import { type PreparedBridge, claimBridge, getBridge } from "./store.js";
import { bridged } from "./wording.js";

interface BridgeRef {
  txHash: string;
  chain: ChainInfo;
  bridgeId?: string;
}

/** Where the user's tokens are, as far as the hub knows: what `RecoveryService.withdrawHubAsset` takes, but the amount. */
interface Recovery {
  srcChainKey: string;
  srcAddress: string;
  token: string;
}

export type BridgeTrack = BridgeRef &
  (
    | { status: "awaiting_source"; seenOnChain: boolean }
    | { status: "source_failed" }
    | {
        status: "not_submitted";
        reason: "not_this_bridge" | "unverified" | "unknown_bridge" | "bridge_used" | "submitted_differently";
        alerted: boolean;
      }
    | { status: "relaying" }
    | { status: "relay_failed"; alerted: boolean }
    | { status: "in_transit"; hubTxHash: string }
    | { status: "delivered"; dstTxHash: string; delivery: "delivered" | "sent" }
    | { status: "held_on_hub"; hubTxHash: string; recovery?: Recovery; alerted: boolean }
  );

export async function trackBridge(input: { txHash: string; bridgeId?: string; chain?: string }): Promise<BridgeTrack> {
  const bridge = input.bridgeId ? getBridge(input.bridgeId) : undefined;
  if (bridge && bridge.keyHash !== callerKeyHash()) {
    throw new ActionError("QUOTE_KEY_MISMATCH", "That bridge was prepared with another SODAX API key.");
  }
  const source = sourceOf(bridge, input.chain);
  const txHash = bridged(() => sourceTxHash(source, input.txHash));
  const base: BridgeRef = { txHash, chain: source.chain, ...(input.bridgeId && { bridgeId: input.bridgeId }) };
  // A row is this build's only once the tx was checked as its deposit; until then it may be anyone's.
  const claimed = bridge?.depositTxHash === txHash;
  const row = await getBridgeTxStatus(txHash, source.chain.key);
  if (row && (claimed || !bridge)) return fromRow(base, row, bridge);

  const deposit = await checkSource(base, source, bridge);
  if (deposit !== "match") return deposit;
  if (!bridge) throw new ActionError("INTERNAL", "A deposit was checked without its build.");
  const claim = claimBridge(bridge.bridgeId, txHash);
  if (claim === "taken") {
    const alerted = alertOperator("unknown_bridge", { chainKey: source.chain.key, txHash, reason: "bridge used" });
    return { ...base, status: "not_submitted", reason: "bridge_used", alerted };
  }
  if (row) return fromRow(base, row, bridge);
  try {
    await submitBridgeTx({
      txHash,
      srcChainKey: source.chain.key,
      walletAddress: bridge.request.srcAddress,
      relayData: bridge.relayData,
    });
  } catch (error) {
    if (!(error instanceof ActionError) || error.details?.reason !== "submitted_differently") throw error;
    const alerted = alertOperator("unknown_bridge", {
      chainKey: source.chain.key,
      txHash,
      reason: "submitted differently",
    });
    return { ...base, status: "not_submitted", reason: "submitted_differently", alerted };
  }
  return { ...base, status: "relaying" };
}

/** The source chain: the build's, or the one the caller names, either a chain a bridge can start from. */
function sourceOf(bridge: PreparedBridge | undefined, chain: string | undefined): SwapSource {
  const catalog = getBridgeCatalog();
  if (!bridge && !chain) {
    throw new ActionError("QUOTE_NOT_FOUND", "That bridgeId isn't known here.", {
      nextStep:
        "Call again with chain set to the bridge's source chain key, or with the bridgeId from sodax_bridge_prepare.",
      details: { field: "chain" },
    });
  }
  const resolved = bridge
    ? toChain(bridge.request.srcChainKey)
    : bridged(() => resolveSwapChain(catalog, chain as string, true, "chain"));
  return { ...bridged(() => sourceChainFor(catalog, resolved, true)), chain: resolved };
}

/** Whether the tx is the build's deposit, or what it is instead. */
async function checkSource(
  base: BridgeRef,
  source: SwapSource,
  bridge: PreparedBridge | undefined,
): Promise<"match" | BridgeTrack> {
  const { txHash, chain } = base;
  const sender = bridge?.request.srcAddress;
  if (isHubChain(chain.key)) {
    const [tx, receipt] = await chainRead(chain, () =>
      Promise.all([getHubTx(txHash), getEvmReceipt(chain.key, txHash)]),
    );
    if (!receipt) return { ...base, status: "awaiting_source", seenOnChain: tx !== null };
    if (receipt.reverted) return { ...base, status: "source_failed" };
    if (!bridge?.deposit) return unknownBridge(base);
    const own =
      tx !== null &&
      same(tx.from, bridge.request.srcAddress) &&
      same(tx.to ?? "", bridge.deposit.to) &&
      same(tx.input, bridge.deposit.data);
    return own ? "match" : { ...base, status: "not_submitted", reason: "not_this_bridge", alerted: false };
  }
  const sourceTx = await readSourceTx(source, txHash, sender);
  if (!sourceTx)
    return { ...base, status: "awaiting_source", seenOnChain: (await seenOnChain(source, txHash, sender)) === true };
  if (sourceTx.failed) return { ...base, status: "source_failed" };
  if (sourceTx.kind !== "spoke") throw new ActionError("INTERNAL", "A spoke read returned a hub tx.");
  if (sourceTx.unreadable) {
    const alerted =
      bridge !== undefined && alertOperator("unknown_bridge", { chainKey: chain.key, txHash, reason: "unreadable" });
    return { ...base, status: "not_submitted", reason: "unverified", alerted };
  }
  if (!bridge) return unknownBridge(base);
  const srcAddress = encodeRecipient(chain.key, bridge.request.srcAddress);
  const srcChain = intentChainId(chain.key);
  if (!srcAddress || !srcChain || source.kind !== "spoke")
    throw new ActionError("INTERNAL", "The build's sender can't be encoded.");
  const deposit = checkDeposit(sourceTx.messages, {
    assetManager: source.depositor,
    srcChain,
    srcAddress,
    to: bridge.relayData.address,
    data: committedPayload(source, bridge.relayData.payload),
  });
  return deposit === "match"
    ? "match"
    : { ...base, status: "not_submitted", reason: "not_this_bridge", alerted: false };
}

/** A mined tx with no build here: the operator finds and submits it if it's a bridge. Only a named build alerts. */
function unknownBridge(base: BridgeRef): BridgeTrack {
  const alerted =
    base.bridgeId !== undefined && alertOperator("unknown_bridge", { chainKey: base.chain.key, txHash: base.txHash });
  return { ...base, status: "not_submitted", reason: "unknown_bridge", alerted };
}

/** What the backend's row says, checked on the hub where it says the hub ran the deposit. */
async function fromRow(base: BridgeRef, row: BridgeTxStatus, bridge: PreparedBridge | undefined): Promise<BridgeTrack> {
  if (row.status === "failed" && row.abandonedAt) {
    // It gave up before the hub: the deposit is held by the source chain's asset manager until someone relays it.
    const alerted = alertOperator("bridge_relay_failed", { chainKey: base.chain.key, txHash: base.txHash });
    return { ...base, status: "relay_failed", alerted };
  }
  const hubTxHash = row.result?.dstIntentTxHash;
  if (row.status !== "executed" || !hubTxHash) return { ...base, status: "relaying" };
  // From Sonic the row's packet is the hub's own, to the destination: executed there is delivered.
  if (isHubChain(base.chain.key))
    return { ...base, status: "delivered", dstTxHash: hubTxHash, delivery: proofOn(bridge) };
  const failed = await chainRead(toChain(HUB_CHAIN_KEY), () => hubHookFailed(hubTxHash));
  if (failed === null) return { ...base, status: "relaying" };
  if (failed) {
    const alerted = alertOperator("bridge_hook_failed", { chainKey: base.chain.key, txHash: base.txHash });
    const recovery = bridge && {
      srcChainKey: bridge.request.srcChainKey,
      srcAddress: bridge.request.srcAddress,
      token: bridge.request.inputToken,
    };
    return { ...base, status: "held_on_hub", hubTxHash, alerted, ...(recovery && { recovery }) };
  }
  // To Sonic the hub tx is the delivery; to a spoke it sends the tokens on, which the relay carries next.
  if (bridge && isHubChain(bridge.request.dstChainKey)) {
    return { ...base, status: "delivered", dstTxHash: hubTxHash, delivery: "delivered" };
  }
  // A relay that fails or answers anything unexpected leaves it in transit, never delivered.
  const packets = await relayPackets(HUB_CHAIN_KEY, hubTxHash).catch(() => []);
  const packet = deliveryPacket(packets, hubTxHash, bridge);
  if (packet?.status === "executed" && packet.dst_tx_hash) {
    return { ...base, status: "delivered", dstTxHash: prefixed(packet.dst_tx_hash), delivery: proofOn(bridge) };
  }
  return { ...base, status: "in_transit", hubTxHash };
}

const prefixed = (hex: string) => (hex.startsWith("0x") ? hex : `0x${hex}`);

/**
 * The packet that carries this bridge on from the hub: sent by the hub asset manager in the hub tx that ran the
 * deposit, from the user's hub wallet to the recipient on the destination chain, the amount the recipient gets (its
 * token is the destination's own spelling, which these four already pin). Exactly one, or none is concluded. Without
 * the build, the hub tx ran this deposit alone: its one asset manager packet is it.
 */
function deliveryPacket(packets: RelayPacket[], hubTxHash: string, bridge?: PreparedBridge): RelayPacket | undefined {
  const fromHub = packets.filter(
    packet =>
      BigInt(packet.src_chain_id) === HUB_RELAY_ID &&
      same(prefixed(packet.src_tx_hash), hubTxHash) &&
      same(prefixed(packet.src_address), hubConfig.addresses.assetManager),
  );
  const ours = bridge ? fromHub.filter(packet => carries(packet, bridge)) : fromHub;
  return ours.length === 1 ? ours[0] : undefined;
}

/** Whether a packet's transfer (RLP: token, sender, recipient, amount, data) is this bridge's delivery. */
function carries(packet: RelayPacket, bridge: PreparedBridge): boolean {
  const { dstChainKey, dstAddress } = bridge.request;
  if (String(packet.dst_chain_id) !== intentChainId(dstChainKey)) return false;
  const items = decodeRlpList(prefixed(packet.payload));
  if (items?.length !== 5) return false;
  const [, sender, recipient, amount] = items;
  const encoded = encodeRecipient(dstChainKey, dstAddress);
  return (
    same(sender, bridge.relayData.address) &&
    encoded !== undefined &&
    same(recipient, encoded) &&
    BigInt(amount === "0x" ? 0 : amount) === bridge.delivered
  );
}

/** On Bitcoin and Injective the relay calls a packet executed once it sent the tx, before that chain ran it. */
function proofOn(bridge: PreparedBridge | undefined): "delivered" | "sent" {
  const dst = bridge?.request.dstChainKey;
  return dst && (isBitcoinChainKey(dst as never) || isInjectiveChainKey(dst as never)) ? "sent" : "delivered";
}
