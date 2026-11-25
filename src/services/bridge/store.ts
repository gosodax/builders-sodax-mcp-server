/**
 * Prepared bridges, in memory, each bound to the API key that prepared it, for submit and track to use. A build is
 * offered for signing for 10 minutes and kept 30 more, as a swap quote is kept 30 minutes past its deadline. Past that,
 * a bridge is tracked from its source tx alone (from every source but Solana, whose tx commits only the payload's
 * hash), so losing the record never strands a deposit that can be read back.
 */

import { randomUUID } from "node:crypto";
import { callerKeyHash } from "../requestContext.js";
import { ActionError } from "../swap/errors.js";
import type { BridgeRequest, BuiltBridge } from "./bridgeApi.js";

export const SIGN_WINDOW_MS = 10 * 60 * 1000;
const GRACE_MS = 30 * 60 * 1000;
const MAX_BRIDGES = 10_000;
const MAX_OPEN_PER_KEY = 1_000;

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
  /** From Sonic, the deposit tx the wallet signs: a hub tx logs no message to check it by, so its calldata is. */
  deposit?: { to: string; data: string };
  /** The deposit checked as this build's: one build, one deposit. */
  depositTxHash?: string;
}

const bridges = new Map<string, PreparedBridge>();

/** Keeps a build, or refuses when this key, or the server, holds too many. */
export function putBridge(
  entry: Omit<PreparedBridge, "bridgeId" | "keyHash" | "signBy" | "expiresAt">,
  now = Date.now(),
): PreparedBridge {
  sweep(now);
  const keyHash = callerKeyHash();
  let open = 0;
  for (const bridge of bridges.values()) if (bridge.keyHash === keyHash && !bridge.depositTxHash) open++;
  if (open >= MAX_OPEN_PER_KEY || bridges.size >= MAX_BRIDGES) {
    throw new ActionError(
      "RATE_LIMITED",
      open >= MAX_OPEN_PER_KEY
        ? "This API key has too many open bridges."
        : "This server holds too many open bridges right now.",
      { details: { retryAfterSec: SIGN_WINDOW_MS / 1000 } },
    );
  }
  const bridge = {
    ...entry,
    bridgeId: randomUUID(),
    keyHash,
    signBy: now + SIGN_WINDOW_MS,
    expiresAt: now + SIGN_WINDOW_MS + GRACE_MS,
  };
  bridges.set(bridge.bridgeId, bridge);
  return bridge;
}

/** A kept build, while it lasts. */
export function getBridge(bridgeId: string, now = Date.now()): PreparedBridge | undefined {
  const bridge = bridges.get(bridgeId);
  if (!bridge || bridge.expiresAt > now) return bridge;
  bridges.delete(bridgeId);
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
  return "claimed";
}

/** Builds kept and not yet sent, for `/health`. */
export function openBridges(now = Date.now()): number {
  sweep(now);
  let open = 0;
  for (const bridge of bridges.values()) if (!bridge.depositTxHash) open++;
  return open;
}

export function clearBridges(): void {
  bridges.clear();
}

function sweep(now: number): void {
  for (const [bridgeId, bridge] of bridges) if (bridge.expiresAt <= now) bridges.delete(bridgeId);
}
