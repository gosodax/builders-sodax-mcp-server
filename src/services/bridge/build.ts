/**
 * A bridge as the user's wallet will send it. The Bridge API builds it (ADR 0001 D3; its build runs the hub
 * simulation, and its allowance check says whether an approve is needed, D5), and the SDK builds it here too
 * (`sdkBridge`): any difference is refused before anyone signs.
 *
 * From an EVM spoke or Sonic, the Bridge API's tx is the one signed, checked byte for byte against the SDK's. From a
 * non-EVM spoke, blockhash, sequence and fees make any two builds differ, so the SDK's tx is the one signed, as for
 * the swap tools, checked by its family (`depositStep`). Either way the relay data, which the hub derives the same way
 * whatever the chain, must equal the SDK's.
 */

import { createHash } from "node:crypto";
import { HUB_CHAIN_KEY } from "@sodax/types";
import { isRecord, sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import { approveCalldata, isHubChain, sdkBridge } from "../sodax.js";
import { ActionError } from "../swap/errors.js";
import { toChain } from "../swap/resolver.js";
import { chainRead } from "../swap/source.js";
import type { NonEvmStep, SwapSource } from "../swap/sources/types.js";
import { type EvmTx, asEvmTx } from "../swap/swapsApi.js";
import {
  type BridgeRequest,
  type BuiltBridge,
  buildBridge,
  buildBridgeApproval,
  checkBridgeAllowance,
} from "./bridgeApi.js";

/** An approve step and the allowance it sets. */
export interface ApproveTx {
  kind: "reset_approve" | "approve";
  tx: EvmTx;
  amount: bigint;
}

export interface CheckedBridge {
  deposit: EvmTx;
  relayData: BuiltBridge["relayData"];
  /** In order: a reset to zero when the token needs one, then the approve, when the allowance is short. */
  approvals: ApproveTx[];
}

/** Built by the Bridge API, checked against the SDK's own build. `native`: the source token is the chain's gas coin. */
export async function buildEvmBridge(request: BridgeRequest, native: boolean): Promise<CheckedBridge> {
  const [built, approved, rebuilt] = await Promise.all([
    buildBridge(request),
    native || checkBridgeAllowance(request),
    // The SDK's build reads the user's hub wallet on the hub.
    chainRead(toChain(HUB_CHAIN_KEY), () => sdkBridge(sdkRequest(request))),
  ]);
  const deposit = asEvmTx(built.tx);
  const expected = asEvmTx(withDecimalValue(rebuilt.tx));
  const depositMismatch = findMismatch([
    ["tx", deposit !== undefined],
    ["rebuild", expected !== undefined],
    ["tx.from", same(deposit?.from ?? "", request.srcAddress)],
    ["tx.to", same(deposit?.to ?? "", expected?.to ?? "")],
    ["tx.value", deposit?.value === expected?.value],
    ["tx.data", same(deposit?.data ?? "", expected?.data ?? "")],
    ["relayData.address", same(built.relayData.address, rebuilt.relayData.address)],
    ["relayData.payload", same(built.relayData.payload, rebuilt.relayData.payload)],
  ]);
  if (depositMismatch || !deposit) throw bridgeMismatch(request, depositMismatch ?? "tx", built.tx);
  if (approved) return { deposit, relayData: built.relayData, approvals: [] };

  // The spender: from a spoke the asset manager the deposit calls, from Sonic the user's hub wallet, which pulls the
  // token (the SDK's `resolveEvmApprovalSpender`).
  const spender = isHubChain(request.srcChainKey) ? rebuilt.relayData.address : deposit.to;
  const { tx, resetTx } = await buildBridgeApproval(request);
  const approvals: ApproveTx[] = [
    ...(resetTx ? [{ kind: "reset_approve" as const, tx: resetTx, amount: 0n }] : []),
    { kind: "approve", tx, amount: request.inputAmount },
  ];
  const approvesExactly = ({ tx: step, amount }: ApproveTx) =>
    same(step.from, request.srcAddress) &&
    same(step.to, request.inputToken) &&
    BigInt(step.value) === 0n &&
    same(step.data, approveCalldata(request.inputToken, spender, amount));
  if (!approvals.every(approvesExactly)) throw bridgeMismatch(request, "approval", tx);
  return { deposit, relayData: built.relayData, approvals };
}

/**
 * From a non-EVM spoke: the deposit step the SDK built, checked by its family against the program the Bridge API's
 * own build calls, and the relay data both agree on.
 */
export async function buildNonEvmBridge(
  request: BridgeRequest,
  source: SwapSource,
  symbol: string,
): Promise<{ step: NonEvmStep; relayData: BuiltBridge["relayData"] }> {
  const { adapter, chain } = source;
  if (!adapter.depositStep) throw new ActionError("INTERNAL", "Not a non-EVM source.");
  const [built, approved, rebuilt] = await Promise.all([
    buildBridge(request),
    checkBridgeAllowance(request),
    // The SDK reads the chain to build it (account, blockhash, coins, fees), and a wallet it can't build for fails the
    // same way as an outage: the Bridge API built it a moment ago, so a retry is more likely to help.
    sdkBridge(sdkRequest(request)).catch(() => {
      throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't prepare the bridge on ${chain.name} right now.`, {
        nextStep: `Retry in a minute. If it still fails, ask the user to check their ${chain.name} wallet holds the amount plus fees and has sent a transaction before, then call sodax_bridge_prepare again.`,
      });
    }),
  ]);
  const relayMismatch = findMismatch([
    ["relayData.address", same(built.relayData.address, rebuilt.relayData.address)],
    ["relayData.payload", same(built.relayData.payload, rebuilt.relayData.payload)],
  ]);
  if (relayMismatch) throw bridgeMismatch(request, relayMismatch, built.tx);
  if (!approved) throw notApproved(source, symbol);
  const expected = isRecord(built.tx) ? built.tx.to : undefined;
  return { step: adapter.depositStep(source, rebuilt.tx, expected), relayData: built.relayData };
}

/** An allowance short of the amount: only Stellar has one from a non-EVM spoke, its trustline's room. */
function notApproved({ adapter, chain }: SwapSource, symbol: string): ActionError {
  if (adapter.family === "STELLAR") {
    return new ActionError("BRIDGE_REJECTED", `The wallet's ${symbol} trustline has too little room for this amount.`, {
      nextStep: `Tell the user their Stellar wallet must raise its ${symbol} trustline limit by the amount sent, then call sodax_bridge_prepare again.`,
      details: { reason: "trustline_room" },
    });
  }
  return new ActionError(
    "BRIDGE_REJECTED",
    `The bridge service says ${symbol} on ${chain.name} needs an approval this server can't build.`,
    {
      nextStep: `Tell the user a bridge of ${symbol} from ${chain.name} isn't available here for now.`,
      details: { reason: "approval_unbuildable" },
    },
  );
}

/** The bridge as the SDK's `createBridgeIntent` takes it. */
function sdkRequest(request: BridgeRequest): Parameters<typeof sdkBridge>[0] {
  return {
    srcChainKey: request.srcChainKey,
    srcAddress: request.srcAddress,
    srcToken: request.inputToken,
    amount: request.inputAmount,
    dstChainKey: request.dstChainKey,
    dstToken: request.outputToken,
    recipient: request.dstAddress,
    partnerFee: request.partnerFee,
  };
}

/** The SDK's raw EVM tx carries its value as a bigint; the API's as a decimal string. */
function withDecimalValue(tx: unknown): unknown {
  if (!tx || typeof tx !== "object" || !("value" in tx) || typeof tx.value !== "bigint") return tx;
  return { ...tx, value: tx.value.toString() };
}

/** The first check that fails, by name. */
function findMismatch(checks: [string, boolean][]): string | undefined {
  return checks.find(([, ok]) => !ok)?.[0];
}

/** Possibly a compromised or broken upstream: enough to investigate, no user addresses. */
function bridgeMismatch(request: BridgeRequest, mismatch: string, builtTx: unknown): ActionError {
  const tx = asEvmTx(builtTx);
  const dataSha256 = tx && createHash("sha256").update(tx.data.toLowerCase()).digest("hex");
  logger.error(
    {
      mismatch,
      "chain.key": request.srcChainKey,
      "dst_chain.key": request.dstChainKey,
      ...(tx && { "tx.to": tx.to, "tx.data_sha256": dataSha256 }),
    },
    "The Bridge API built a bridge that doesn't match the SDK's",
  );
  return new ActionError("BRIDGE_MISMATCH", "The bridge service built a different bridge than the one asked for.", {
    details: { chainKey: request.srcChainKey },
  });
}
