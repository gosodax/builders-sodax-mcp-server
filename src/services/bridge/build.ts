/**
 * A bridge from an EVM spoke or Sonic, as the user's wallet will send it. The Bridge API builds it (ADR 0001 D3; its
 * build runs the hub simulation, and its allowance check says whether an approve is needed, D5). This server rebuilds
 * it with the SDK and refuses any difference before anyone signs. The relay carries an EVM deposit by its hash alone,
 * so the deposit tx, not the relay data, is what runs on the hub: both are checked.
 */

import { createHash } from "node:crypto";
import { HUB_CHAIN_KEY } from "@sodax/types";
import { sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import { approveCalldata, isHubChain, sdkBridge } from "../sodax.js";
import { ActionError } from "../swap/errors.js";
import { toChain } from "../swap/resolver.js";
import { chainRead } from "../swap/source.js";
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
    chainRead(toChain(HUB_CHAIN_KEY), () =>
      sdkBridge({
        srcChainKey: request.srcChainKey,
        srcAddress: request.srcAddress,
        srcToken: request.inputToken,
        amount: request.inputAmount,
        dstChainKey: request.dstChainKey,
        dstToken: request.outputToken,
        recipient: request.dstAddress,
        partnerFee: request.partnerFee,
      }),
    ),
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
