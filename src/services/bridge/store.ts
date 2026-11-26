/**
 * Prepared bridges, in memory, each bound to the API key that prepared it, for submit and track to use. A build is
 * offered for signing for 5 minutes and kept 30 more, as a swap quote is kept 30 minutes past its deadline; one with
 * no deposit, past its sign-by and not held by a track call, gives way when a new one needs the room. Once its deposit
 * is checked it's kept a day: track submits the deposit, and proves a delivery to Sonic, only with it, and a bridge
 * relayed by hand can take hours. Past `MAX_CLAIMED` the oldest one the backend or an operator already has gives way.
 * Without it (gone, or a restart), a deposit the backend doesn't have yet is left to the operator (`unknown_bridge`),
 * and one it has is still followed.
 */

import { randomUUID } from "node:crypto";
import { callerKeyHash, getRequestContext, runWithRequestContext } from "../requestContext.js";
import {
  MAX_OPEN_PER_CLIENT,
  SIGN_WINDOW_MS,
  SIGN_WINDOW_TEXT,
  addOpen,
  freesAt,
  releasable,
  removeOpen,
  secondsUntil,
} from "../signWindow.js";
import { ActionError } from "../swap/errors.js";
import type { BridgeRequest, BuiltBridge } from "./bridgeApi.js";

const GRACE_MS = 30 * 60 * 1000;
const MAX_BRIDGES = 10_000;
const MAX_OPEN_PER_KEY = 1_000;
const CLAIMED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CLAIMED = 10_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface PreparedBridge {
  bridgeId: string;
  /** SHA-256 of the API key that prepared it: only that key can use it. */
  keyHash: string;
  /** The preparing client's hashed IP, over HTTP. */
  clientId?: string;
  /** Epoch ms: the build is no longer offered for signing. */
  signBy: number;
  /** Epoch ms: the record goes. */
  expiresAt: number;
  request: BridgeRequest;
  relayData: BuiltBridge["relayData"];
  /** What the recipient gets, in the received token's base units. */
  delivered: bigint;
  /** From Sonic, the deposit tx the wallet signs: a hub tx logs no message to check it by, so the tx itself is. */
  deposit?: { to: string; data: string; value: string };
  /** The deposit checked as this build's: one build, one deposit. */
  depositTxHash?: string;
  /** That deposit is the backend's, or an operator's to relay: a restart no longer strands it. */
  handedOver?: true;
  /**
   * Epoch ms: a track call with a well-formed hash holds it this long, its deposit maybe on the way. Only a deposit
   * checked as its own (`depositTxHash`) keeps it for good.
   */
  heldUntil?: number;
}

// Builds not yet sent, and builds with a checked deposit. Within each every record lives as long, so insertion order is
// expiry order, which the sweep relies on (and sign-by order, which `makeRoom` does). Only a deposit checked on chain
// against its build makes a claimed one: nothing but real bridges fills it, and `makeClaimedRoom` bounds it.
const bridges = new Map<string, PreparedBridge>();
const claimed = new Map<string, PreparedBridge>();
// Per key, and per client, its builds not yet sent.
const openByKey = new Map<string, Set<string>>();
const openByClient = new Map<string, Set<string>>();
let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Makes room for a build, or refuses: a key or a client at its cap of builds not yet sent, or a full server, first
 * drops its oldest build nobody sent or tracked by its sign-by. Checked before a bridge is built, so a refusal costs
 * no upstream call, and again when it's kept.
 */
export function checkBridgeRoom(keyHash = callerKeyHash(), clientId = getRequestContext().clientId): void {
  sweep();
  checkCap(openByKey.get(keyHash), MAX_OPEN_PER_KEY, "This API key has too many open bridges.");
  if (clientId) checkCap(openByClient.get(clientId), MAX_OPEN_PER_CLIENT, "This client has too many open bridges.");
  if (bridges.size >= MAX_BRIDGES && !makeRoom(bridges.keys())) {
    throw noRoom("This server holds too many open bridges right now.", bridges.keys());
  }
}

function checkCap(open: Set<string> | undefined, max: number, message: string): void {
  if (open && open.size >= max && !makeRoom(open)) throw noRoom(message, open);
}

/**
 * Drops the oldest releasable build of `ids` (kept order is age order): a deposit sent that late is still followed
 * without its build, as after a restart.
 */
function makeRoom(ids: Iterable<string>): boolean {
  const now = Date.now();
  for (const bridgeId of ids) {
    const bridge = bridges.get(bridgeId);
    if (!bridge) continue;
    if (bridge.signBy > now) return false;
    if (!releasable(bridge, now)) continue;
    drop(bridge);
    return true;
  }
  return false;
}

/** Room comes back when the first build holding it can give way: past its sign-by and any hold. */
function noRoom(message: string, holding: Iterable<string>): ActionError {
  const now = Date.now();
  let first = Number.POSITIVE_INFINITY;
  for (const bridgeId of holding) {
    const bridge = bridges.get(bridgeId);
    if (bridge) first = Math.min(first, freesAt(bridge));
  }
  return new ActionError("RATE_LIMITED", message, {
    nextStep: `Tell the user too many bridges were prepared here and not yet sent, and wait retryAfterSec seconds before preparing again: a bridge no one sent gives way ${SIGN_WINDOW_TEXT} after it was prepared. sodax_bridge_preview still works meanwhile: it holds none.`,
    details: { retryAfterSec: secondsUntil(Math.min(first, now + SIGN_WINDOW_MS), now) },
  });
}

/** Keeps a build, or refuses as `checkBridgeRoom` does. */
export function putBridge(
  entry: Omit<PreparedBridge, "bridgeId" | "keyHash" | "signBy" | "expiresAt">,
): PreparedBridge {
  const keyHash = callerKeyHash();
  const { clientId } = getRequestContext();
  checkBridgeRoom(keyHash, clientId);
  const now = Date.now();
  const bridge: PreparedBridge = {
    ...entry,
    bridgeId: randomUUID(),
    keyHash,
    ...(clientId && { clientId }),
    signBy: now + SIGN_WINDOW_MS,
    expiresAt: now + SIGN_WINDOW_MS + GRACE_MS,
  };
  bridges.set(bridge.bridgeId, bridge);
  addOpen(openByKey, keyHash, bridge.bridgeId);
  if (clientId) addOpen(openByClient, clientId, bridge.bridgeId);
  // Created outside any request, so its runs don't carry the one that started it.
  sweepTimer ??= runWithRequestContext({}, () => setInterval(sweep, SWEEP_INTERVAL_MS).unref());
  return bridge;
}

/** A kept build, while it lasts. */
export function getBridge(bridgeId: string): PreparedBridge | undefined {
  const bridge = bridges.get(bridgeId) ?? claimed.get(bridgeId);
  if (!bridge || bridge.expiresAt > Date.now()) return bridge;
  drop(bridge);
  return undefined;
}

/**
 * Binds a checked deposit to its build: one build, one deposit. `taken` when another tx holds it, `gone` when the build
 * expired meanwhile.
 */
export function claimBridge(bridgeId: string, txHash: string): "claimed" | "taken" | "gone" {
  const bridge = getBridge(bridgeId);
  if (!bridge) return "gone";
  if (bridge.depositTxHash) return bridge.depositTxHash === txHash ? "claimed" : "taken";
  bridge.depositTxHash = txHash;
  bridge.expiresAt = Date.now() + CLAIMED_RETENTION_MS;
  bridges.delete(bridgeId);
  unopen(bridge);
  makeClaimedRoom();
  claimed.set(bridgeId, bridge);
  return "claimed";
}

/**
 * Drops the oldest builds whose deposit is handed over until there's room: tracked after, one is followed by its
 * backend row, as after a restart. One not handed over stays, past the cap if it must: only its build submits it.
 */
function makeClaimedRoom(): void {
  for (const bridge of claimed.values()) {
    if (claimed.size < MAX_CLAIMED) return;
    if (bridge.handedOver) drop(bridge);
  }
}

/** The build's deposit is the backend's, or an operator's to relay. */
export function markHandedOver(bridge: PreparedBridge): void {
  bridge.handedOver = true;
}

/**
 * Builds a restart would strand, for `/health` and the stop and crash alerts: not sent yet, or sent and not yet handed
 * over. A deposit is submitted only against its build.
 */
export function openBridges(): number {
  sweep();
  let open = bridges.size;
  for (const bridge of claimed.values()) if (!bridge.handedOver) open++;
  return open;
}

function sweep(): void {
  const now = Date.now();
  for (const kept of [bridges, claimed]) {
    for (const bridge of kept.values()) {
      if (bridge.expiresAt > now) break;
      drop(bridge);
    }
  }
  if (bridges.size === 0 && claimed.size === 0) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

function drop(bridge: PreparedBridge): void {
  bridges.delete(bridge.bridgeId);
  claimed.delete(bridge.bridgeId);
  unopen(bridge);
}

function unopen({ keyHash, clientId, bridgeId }: PreparedBridge): void {
  removeOpen(openByKey, keyHash, bridgeId);
  if (clientId) removeOpen(openByClient, clientId, bridgeId);
}
