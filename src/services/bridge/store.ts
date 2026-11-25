/**
 * Prepared bridges, in memory, each bound to the API key that prepared it, for submit and track to use. A build is
 * offered for signing for 10 minutes and kept 30 more, as a swap quote is kept 30 minutes past its deadline. Track
 * submits a deposit only against its build: past that, or after a restart, one the backend doesn't have yet is left to
 * the operator (`unknown_bridge`), and one it has is still followed.
 */

import { randomUUID } from "node:crypto";
import { callerKeyHash, runWithRequestContext } from "../requestContext.js";
import { ActionError } from "../swap/errors.js";
import type { BridgeRequest, BuiltBridge } from "./bridgeApi.js";

export const SIGN_WINDOW_MS = 10 * 60 * 1000;
const GRACE_MS = 30 * 60 * 1000;
const MAX_BRIDGES = 10_000;
const MAX_OPEN_PER_KEY = 1_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface PreparedBridge {
  bridgeId: string;
  /** SHA-256 of the API key that prepared it: only that key can use it. */
  keyHash: string;
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
}

// Every record lives as long, so insertion order is expiry order, which the sweep relies on.
const bridges = new Map<string, PreparedBridge>();
// Per key, its builds not yet sent.
const openByKey = new Map<string, Set<string>>();
let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Refuses a key holding too many builds not yet sent, or any key while the server holds too many: checked before a
 * bridge is built, so a key at its cap costs no upstream call, and again when it's kept.
 */
export function checkBridgeRoom(keyHash = callerKeyHash()): void {
  sweep();
  const full = (openByKey.get(keyHash)?.size ?? 0) >= MAX_OPEN_PER_KEY;
  if (!full && bridges.size < MAX_BRIDGES) return;
  throw new ActionError(
    "RATE_LIMITED",
    full ? "This API key has too many open bridges." : "This server holds too many open bridges right now.",
    { details: { retryAfterSec: SIGN_WINDOW_MS / 1000 } },
  );
}

/** Keeps a build, or refuses when this key, or the server, holds too many. */
export function putBridge(
  entry: Omit<PreparedBridge, "bridgeId" | "keyHash" | "signBy" | "expiresAt">,
): PreparedBridge {
  const keyHash = callerKeyHash();
  checkBridgeRoom(keyHash);
  const now = Date.now();
  const bridge = {
    ...entry,
    bridgeId: randomUUID(),
    keyHash,
    signBy: now + SIGN_WINDOW_MS,
    expiresAt: now + SIGN_WINDOW_MS + GRACE_MS,
  };
  bridges.set(bridge.bridgeId, bridge);
  openByKey.set(keyHash, (openByKey.get(keyHash) ?? new Set()).add(bridge.bridgeId));
  // Created outside any request, so its runs don't carry the one that started it.
  sweepTimer ??= runWithRequestContext({}, () => setInterval(sweep, SWEEP_INTERVAL_MS).unref());
  return bridge;
}

/** A kept build, while it lasts. */
export function getBridge(bridgeId: string): PreparedBridge | undefined {
  const bridge = bridges.get(bridgeId);
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
  if (bridge.depositTxHash && bridge.depositTxHash !== txHash) return "taken";
  bridge.depositTxHash = txHash;
  unopen(bridge);
  return "claimed";
}

/** Builds kept and not yet sent, for `/health`: a restart loses them, and a deposit is submitted only against its build. */
export function openBridges(): number {
  sweep();
  let open = 0;
  for (const ids of openByKey.values()) open += ids.size;
  return open;
}

function sweep(): void {
  const now = Date.now();
  for (const bridge of bridges.values()) {
    if (bridge.expiresAt > now) break;
    drop(bridge);
  }
  if (bridges.size === 0) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

function drop(bridge: PreparedBridge): void {
  bridges.delete(bridge.bridgeId);
  unopen(bridge);
}

function unopen({ keyHash, bridgeId }: PreparedBridge): void {
  const open = openByKey.get(keyHash);
  open?.delete(bridgeId);
  if (open?.size === 0) openByKey.delete(keyHash);
}
