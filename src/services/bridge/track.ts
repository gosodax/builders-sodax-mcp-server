/**
 * `sodax_bridge_submit_and_track`: a sent bridge checked on its source chain against its build, submitted once, then
 * followed to the hub and on. Track trusts only the build kept here and the chains: a backend row is read for its
 * progress, never as proof that a tx is this bridge's deposit.
 *
 * Without the build (a restart, or 35 minutes past a prepare never tracked), a bridge the backend already has is still
 * followed; one it hasn't is left to the operator, as the swap tools do with a deposit whose quote is gone. Track runs
 * right after the wallet broadcasts, so that's a bridge signed and never tracked in time.
 */

import { HUB_CHAIN_KEY, hubConfig, isBitcoinChainKey, isInjectiveChainKey, spokeChainConfig } from "@sodax/types";
import { EVM_TX_HASH_PATTERN, sameHex as same } from "../../constants.js";
import { callerKeyHash } from "../requestContext.js";
import { holdForTrack } from "../signWindow.js";
import {
  type EvmReceipt,
  type RelayPacket,
  bridgeHubAsset,
  encodeRecipient,
  getEvmReceipt,
  getHubTx,
  intentChainId,
  isHubChain,
  relayPackets,
} from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { alertOperator } from "../swap/alerts.js";
import { ActionError } from "../swap/errors.js";
import { resolveSwapChain, toChain } from "../swap/resolver.js";
import { chainRead, depositTerms, readSourceTx, seenOnChain, sourceChainFor, sourceTxHash } from "../swap/source.js";
import {
  HOOK_FAILED_TOPIC,
  HUB_RELAY_ID,
  TRANSFER_TOPIC,
  WITHDRAWAL_TOPIC,
  checkDeposit,
  decodeRlpList,
} from "../swap/sourceTx.js";
import type { SwapSource } from "../swap/sources/types.js";
import { readWhileWaiting } from "../trackWait.js";
import { TtlCache } from "../ttlCache.js";
import { type BridgeTxStatus, getBridgeTxStatus, submitBridgeTx } from "./bridgeApi.js";
import { getBridgeCatalog } from "./catalog.js";
import { type PreparedBridge, claimBridge, getBridge, markHandedOver } from "./store.js";

interface BridgeRef {
  txHash: string;
  chain: ChainInfo;
  bridgeId?: string;
  /** At a stage the bridge waits at (not mined, relaying, in transit): polled until then, absent once that passed. */
  pollUntil?: string;
}

/** Where the user's tokens are, as far as the hub knows: what `RecoveryService.withdrawHubAsset` takes, but the amount. */
interface Recovery {
  srcChainKey: string;
  srcAddress: string;
  token: string;
}

export type BridgeTrack = BridgeRef &
  /** Not mined. `seenOnChain`: the node has it pending (true), doesn't know it at all (false), or can't say (null). */
  (
    | { status: "awaiting_source"; seenOnChain: boolean | null }
    | { status: "source_failed" }
    | {
        status: "not_submitted";
        reason:
          | "not_this_bridge"
          | "unverified"
          | "unknown_bridge"
          | "bridge_used"
          | "submitted_differently"
          | "submit_refused"
          | "multiple_messages";
        alerted: boolean;
      }
    | { status: "relaying" }
    | { status: "relay_failed"; alerted: boolean }
    | { status: "in_transit"; hubTxHash: string }
    | { status: "delivered"; dstTxHash: string; delivery: "delivered" | "sent" }
    | { status: "held_on_hub"; hubTxHash: string; recovery?: Recovery; alerted: boolean }
  );

type TrackInput = { txHash: string; bridgeId?: string; chain?: string };

// How long each stage is polled, from the first call that found the bridge there; past that a person takes over. A
// node that doesn't know the tx at all after two minutes most likely has another hash: a batch id, the approve's.
const POLL_SEC = { unseen: 2 * 60, source: 10 * 60, relay: 10 * 60, transit: 10 * 60 } as const;
const RESUBMIT_AFTER_MS = 60 * 1000;
// When each caller first found each bridge at each stage: the server's clock bounds the polls, not the agent's count.
const stageSince = new TtlCache(60 * 60 * 1000, 10_000);
// One check per caller, bridge and tx at a time: submit-tx allows 10 a minute per IP, which every MCP user shares.
const inFlight = new Map<string, Promise<BridgeTrack>>();

/** `trackBridge`, repeated every few seconds while the bridge waits (`readWhileWaiting`). */
export function trackBridgeWaiting(input: TrackInput): Promise<BridgeTrack> {
  return readWhileWaiting(
    () => trackBridge(input),
    // Only while the stage is still polled: past its budget the answer is a hand-off, given at once.
    result => result.pollUntil !== undefined,
    result => `${result.status}:${"seenOnChain" in result ? result.seenOnChain : ""}`,
  );
}

async function trackBridge(input: TrackInput): Promise<BridgeTrack> {
  const bridge = input.bridgeId ? getBridge(input.bridgeId) : undefined;
  if (bridge && bridge.keyHash !== callerKeyHash()) {
    throw new ActionError("QUOTE_KEY_MISMATCH", "That bridge was prepared with another SODAX API key.");
  }
  const source = sourceOf(input, bridge);
  const txHash = sourceTxHash(source, input.txHash, "bridge");
  // The bridgeId too: a call without the build must never answer for one with it.
  const key = JSON.stringify([callerKeyHash(), source.chain.key, txHash, input.bridgeId ?? null]);
  let pending = inFlight.get(key);
  if (!pending) {
    const base: BridgeRef = { txHash, chain: source.chain, ...(input.bridgeId && { bridgeId: input.bridgeId }) };
    pending = follow(base, source, bridge)
      .then(polled)
      .catch(error => {
        // Once a deposit is bound to the build, never "get a new key": only this key can track it, so a new one would
        // leave it unsubmitted for a person to find. As in the swap tools' track, it's retried.
        throw bridge?.depositTxHash && error instanceof ActionError && error.code === "API_KEY_REQUIRED"
          ? new ActionError("UPSTREAM_UNAVAILABLE", "The bridge service refused this server's request for now.", {
              details: { retryAfterSec: 60 },
            })
          : error;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

function pollStage(result: BridgeTrack): keyof typeof POLL_SEC | undefined {
  switch (result.status) {
    case "awaiting_source":
      return result.seenOnChain === false ? "unseen" : "source";
    case "relaying":
      return "relay";
    case "in_transit":
      return "transit";
    default:
      return undefined;
  }
}

/** A waiting result with the time its stage is polled until, while that's ahead. */
function polled(result: BridgeTrack): BridgeTrack {
  const stage = pollStage(result);
  if (!stage) return result;
  const key = JSON.stringify([callerKeyHash(), result.chain.key, result.txHash, stage]);
  const now = Date.now();
  const since = stageSince.get<number>(key) ?? now;
  stageSince.set(key, since);
  const until = since + POLL_SEC[stage] * 1000;
  return now < until ? { ...result, pollUntil: new Date(until).toISOString() } : result;
}

/** Test only. */
export function clearPollClock(): void {
  stageSince.clear();
}

async function follow(base: BridgeRef, source: SwapSource, bridge: PreparedBridge | undefined): Promise<BridgeTrack> {
  const { txHash } = base;
  // Only once the hash is one the chain can have: a malformed one holds nothing.
  if (bridge) holdForTrack(bridge);
  // A row is this build's only once the tx was checked as its deposit; until then it may be anyone's, so it's read
  // only after that check, and a deposit not mined yet costs no Bridge API call.
  const trusted = !bridge || bridge.depositTxHash === txHash;
  const known = trusted ? await getBridgeTxStatus(txHash, source.chain.key) : null;
  if (known) return fromRow(base, known, bridge);
  const how = bridge?.handedOver;
  if (trusted && (how === "submitted_differently" || how === "submit_refused")) {
    return { ...base, status: "not_submitted", reason: how, alerted: false };
  }
  // Submitted here, its row not readable yet: followed. A row the backend lost is submitted again, but submit-tx takes
  // 10 a minute per IP, shared by every MCP user: at most once a minute.
  if (trusted && bridge?.submittedAt && Date.now() - bridge.submittedAt < RESUBMIT_AFTER_MS) {
    return { ...base, status: "relaying" };
  }

  const deposit = await checkSource(base, source, bridge);
  if (deposit !== "match") return deposit;
  if (!bridge) throw new ActionError("INTERNAL", "A deposit was checked without its build.");
  const claim = claimBridge(bridge.bridgeId, txHash);
  if (claim === "taken") {
    const alerted = alertOperator("bridge_used", { chainKey: source.chain.key, txHash });
    return { ...base, status: "not_submitted", reason: "bridge_used", alerted };
  }
  const row = trusted ? null : await getBridgeTxStatus(txHash, source.chain.key);
  if (row) return fromRow(base, row, bridge);
  try {
    await submitBridgeTx({
      txHash,
      srcChainKey: source.chain.key,
      walletAddress: bridge.request.srcAddress,
      relayData: bridge.relayData,
    });
  } catch (error) {
    // One that may pass on a repeat is the agent's to retry: the claim stays, so the next call submits again.
    if (!isRefusal(error)) throw error;
    // The deposit is checked and on chain, and no repeat gets it submitted: only an operator can, as the swap tools'
    // `submit_rejected`. Either way it's the operator's now, and a repeat reports it without submitting again.
    const reason = error.details?.reason === "submitted_differently" ? "submitted_differently" : "submit_refused";
    markHandedOver(bridge, reason);
    const kind = reason === "submitted_differently" ? "bridge_submitted_differently" : "bridge_submit_rejected";
    const alerted = alertOperator(kind, { chainKey: source.chain.key, txHash });
    return { ...base, status: "not_submitted", reason, alerted };
  }
  markHandedOver(bridge, "submitted");
  return { ...base, status: "relaying" };
}

/**
 * A failure that calling again won't fix. A key refusal (401/403) is of the request, not the bridge, so it isn't one:
 * as in the swap tools' track.
 */
const isRefusal = (error: unknown): error is ActionError =>
  error instanceof ActionError && !error.retryable && error.code !== "API_KEY_REQUIRED";

/** The source chain: the build's, or the one the caller names, either a chain a bridge can start from. */
function sourceOf({ bridgeId, chain }: TrackInput, bridge: PreparedBridge | undefined): SwapSource {
  const catalog = getBridgeCatalog();
  if (!bridge && !chain) {
    const message = bridgeId
      ? "That bridgeId isn't known here: it expired, or this server restarted since."
      : "A bridge's transaction hash needs its source chain, or the bridgeId from sodax_bridge_prepare.";
    throw new ActionError("QUOTE_NOT_FOUND", message, {
      nextStep:
        "Call again with chain set to the bridge's source chain key, or with the bridgeId from sodax_bridge_prepare. The user must not send the bridge again.",
      details: { field: "chain" },
    });
  }
  const resolved = bridge
    ? toChain(bridge.request.srcChainKey)
    : resolveSwapChain(catalog, chain as string, true, "chain");
  return { ...sourceChainFor(catalog, resolved, true), chain: resolved };
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
    // A node behind a load balancer can serve the receipt before the tx: it's mined, so the tx comes next.
    if (tx === null) return { ...base, status: "awaiting_source", seenOnChain: true };
    const own =
      same(tx.from, bridge.request.srcAddress) &&
      same(tx.to ?? "", bridge.deposit.to) &&
      tx.value === BigInt(bridge.deposit.value) &&
      same(tx.input, bridge.deposit.data);
    return own ? "match" : { ...base, status: "not_submitted", reason: "not_this_bridge", alerted: false };
  }
  const sourceTx = await readSourceTx(source, txHash, sender);
  if (!sourceTx)
    return { ...base, status: "awaiting_source", seenOnChain: (await seenOnChain(source, txHash, sender)) ?? null };
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
  const deposit = checkDeposit(
    sourceTx.messages,
    depositTerms(source, { intent: { srcChain, srcAddress }, relayData: bridge.relayData }),
  );
  if (deposit !== "match") return { ...base, status: "not_submitted", reason: "not_this_bridge", alerted: false };
  // The backend keys a bridge on its tx and follows the tx's first packet, whoever sent it: any other message in the tx
  // (another deposit, a cancel, a direct message; an ERC-4337 bundle can carry other users') may be the one it follows.
  // An operator relays this deposit by hand.
  if (sourceTx.messages.length > 1) {
    const alerted = alertOperator("bridge_multiple_messages", { chainKey: chain.key, txHash });
    return { ...base, status: "not_submitted", reason: "multiple_messages", alerted };
  }
  return "match";
}

/** A mined tx with no build here: the operator finds and submits it if it's a bridge. Only a named build alerts. */
function unknownBridge(base: BridgeRef): BridgeTrack {
  const alerted =
    base.bridgeId !== undefined && alertOperator("unknown_bridge", { chainKey: base.chain.key, txHash: base.txHash });
  return { ...base, status: "not_submitted", reason: "unknown_bridge", alerted };
}

/**
 * What the backend's row says of the bridge's progress: each step past the source is proved on the hub or by the relay,
 * never taken from the row.
 */
async function fromRow(base: BridgeRef, row: BridgeTxStatus, bridge: PreparedBridge | undefined): Promise<BridgeTrack> {
  // Only a build whose deposit this is comes here: the backend has it.
  if (bridge) markHandedOver(bridge, "row");
  // Without the build, nothing here checked the tx as a deposit: its alerts spend the budget any key can.
  const alert = (kind: "bridge_relay_failed" | "bridge_hook_failed") =>
    alertOperator(kind, { chainKey: base.chain.key, txHash: base.txHash }, { unchecked: !bridge });
  // The SDK's rule (`BridgeService.getDetailedStatus`): a row the backend failed or gave up on is stale, not a verdict.
  // The relay may have carried the bridge anyway, relayed by hand or landing after the give-up, so it's asked; one it
  // hasn't carried either is held until someone relays it.
  const stale = row.status === "failed" || Boolean(row.abandonedAt);
  const fromHub = isHubChain(base.chain.key);
  const held = (): BridgeTrack => ({ ...base, status: "relay_failed", alerted: alert("bridge_relay_failed") });
  const notYet = (): BridgeTrack => (stale ? held() : { ...base, status: "relaying" });
  if (!stale && row.status !== "executed") return notYet();
  // From Sonic the user's own tx ran on the hub; from a spoke, the hub tx the row names, or for a stale row the one the
  // relay delivered the deposit in, checked below.
  const hubTxHash = fromHub ? base.txHash : stale ? await relayedToHub(base) : row.result?.dstIntentTxHash;
  if (!hubTxHash) return notYet();
  const toHub = bridge !== undefined && isHubChain(bridge.request.dstChainKey);
  const [receipt, packets] = await Promise.all([
    chainRead(toChain(HUB_CHAIN_KEY), () => getEvmReceipt(HUB_CHAIN_KEY, hubTxHash)),
    // A relay that fails or answers anything unexpected leaves it in transit, never delivered.
    toHub ? [] : relayPackets(HUB_CHAIN_KEY, hubTxHash).catch((): RelayPacket[] => []),
  ]);
  // Not mined where the row says, or reverted there: nothing ran on the hub yet.
  if (!receipt || receipt.reverted) return notYet();
  if (hookFailed(receipt, bridge)) {
    const recovery = bridge && {
      srcChainKey: bridge.request.srcChainKey,
      srcAddress: bridge.request.srcAddress,
      token: bridge.request.srcToken,
    };
    return {
      ...base,
      status: "held_on_hub",
      hubTxHash,
      alerted: alert("bridge_hook_failed"),
      ...(recovery && { recovery }),
    };
  }
  // To Sonic the hub tx is the delivery, which its receipt shows; to a spoke it sends the tokens on, which the relay
  // carries next. Without the build, a delivery to Sonic can't be told from one still to leave: it stays in transit.
  if (toHub && deliveredOnHub(receipt, bridge)) {
    return { ...base, status: "delivered", dstTxHash: hubTxHash, delivery: "delivered" };
  }
  const packet = toHub ? undefined : deliveryPacket(packets, hubTxHash, bridge);
  // The destination chain's own hash, as the relay reports it: base58 on Solana, a txid without 0x on Bitcoin.
  if (packet?.status === "executed" && packet.dst_tx_hash) {
    return { ...base, status: "delivered", dstTxHash: packet.dst_tx_hash, delivery: proofOn(packet) };
  }
  // From a spoke, the relay carries it on from the hub by itself. From Sonic, the backend's row was watching for just
  // that packet: given up on, it's held.
  return stale && fromHub ? held() : { ...base, status: "in_transit", hubTxHash };
}

/**
 * The hub tx the relay delivered a spoke deposit in, as the SDK and the backend find it: the source tx's one packet,
 * executed on the hub. None when the relay hasn't. A relay that can't be read says nothing, so it's retried: taken for
 * "not relayed", a row the backend gave up on would end the bridge as held.
 */
async function relayedToHub({ chain, txHash }: BridgeRef): Promise<string | undefined> {
  const packets = await relayPackets(chain.key, txHash).catch(() => {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX relay can't be read right now.");
  });
  const landed = packets.filter(
    packet =>
      String(packet.src_chain_id) === intentChainId(chain.key) &&
      same(prefixed(packet.src_tx_hash), prefixed(txHash)) &&
      BigInt(packet.dst_chain_id) === HUB_RELAY_ID &&
      packet.status === "executed" &&
      EVM_TX_HASH_PATTERN.test(packet.dst_tx_hash ?? ""),
  );
  return landed.length === 1 ? landed[0]?.dst_tx_hash : undefined;
}

/** An address as a log names it in an indexed topic or a data word: the last 20 bytes of 32. */
const isWord = (word: string | undefined, address: string) =>
  word !== undefined && word.length === 66 && same(`0x${word.slice(26)}`, address);

/**
 * The hub ran the deposit but not the hub wallet's calls after it: the tokens stay in that wallet, the event's first
 * data word. With the build, only this bridge's wallet counts; without it, the hub tx ran this deposit alone.
 */
const hookFailed = ({ logs }: EvmReceipt, bridge?: PreparedBridge) =>
  logs.some(
    log =>
      same(log.address, hubConfig.addresses.assetManager) &&
      same(log.topics[0] ?? "", HOOK_FAILED_TOPIC) &&
      (!bridge || isWord(log.data.slice(0, 66), bridge.relayData.address)),
  );

/**
 * A bridge to Sonic ends with the hub wallet's last call, as the SDK builds it: the token transferred to the recipient,
 * or wrapped S unwrapped to them (`withdrawTo`), the amount the recipient gets. Its receipt must show that.
 */
function deliveredOnHub({ logs }: EvmReceipt, bridge: PreparedBridge): boolean {
  const { dstChainKey, dstToken, recipient } = bridge.request;
  const token = bridgeHubAsset({ chainKey: dstChainKey, address: dstToken });
  const wallet = bridge.relayData.address;
  const amount = (data: string) => data.length === 66 && BigInt(data) === bridge.delivered;
  const native = same(dstToken, hubConfig.nativeToken);
  return logs.some(({ address, topics: [topic, first, second], data }) => {
    if (!same(address, token) || !amount(data)) return false;
    return native
      ? same(topic ?? "", WITHDRAWAL_TOPIC) && (isWord(first, wallet) || isWord(first, recipient))
      : same(topic ?? "", TRANSFER_TOPIC) && isWord(first, wallet) && isWord(second, recipient);
  });
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
  const { dstChainKey } = bridge.request;
  if (String(packet.dst_chain_id) !== intentChainId(dstChainKey)) return false;
  const items = decodeRlpList(prefixed(packet.payload));
  if (items?.length !== 5) return false;
  const [, sender, recipient, amount] = items;
  const encoded = encodeRecipient(dstChainKey, bridge.request.recipient);
  return (
    same(sender, bridge.relayData.address) &&
    encoded !== undefined &&
    same(recipient, encoded) &&
    BigInt(amount === "0x" ? 0 : amount) === bridge.delivered
  );
}

/** On Bitcoin and Injective the relay calls a packet executed once it sent the tx, before that chain ran it. */
const SENT_ONLY = new Set(
  Object.keys(spokeChainConfig)
    .filter(key => isBitcoinChainKey(key as never) || isInjectiveChainKey(key as never))
    .map(intentChainId),
);

function proofOn(packet: RelayPacket): "delivered" | "sent" {
  return SENT_ONLY.has(String(packet.dst_chain_id)) ? "sent" : "delivered";
}
