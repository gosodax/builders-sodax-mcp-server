/**
 * EVM sources: a spoke, whose `connection` logs prove a deposit or a cancel, and the hub, whose intents contract
 * logs the intents a swap or a cancel created or cancelled. Their swap txs come from the Swaps API and are checked
 * byte for byte against the SDK's rebuild.
 */

import { createHash } from "node:crypto";
import { EVM_TX_HASH_PATTERN, sameHex as same } from "../../../constants.js";
import { logger } from "../../logger.js";
import {
  type SwapTx,
  approveCalldata,
  blockNumber,
  cancelPayload,
  getEvmReceipt,
  hubCancelTx,
  isTxKnown,
  rebuildSwapTx,
} from "../../sodax.js";
import { ActionError } from "../errors.js";
import {
  HUB_RELAY_ID,
  INTENT_CANCELLED_TOPIC,
  INTENT_CREATED_TOPIC,
  connectionMessages,
  decodeSendMessage,
  hubIntentHashes,
} from "../sourceTx.js";
import {
  type Approval,
  type EvmTx,
  type Intent,
  type IntentRequest,
  asEvmTx,
  buildApprove,
  buildCancel,
  parseEvmTx,
} from "../swapsApi.js";
import type { CancelStep, SourceAdapter, StepTx, SwapBatch, SwapSource, SwapStep, SwapToBuild } from "./types.js";

const evm: Omit<SourceAdapter, "read" | "cancelStep"> = {
  family: "EVM",
  txHash: {
    format: "0x and 64 hex characters",
    spell: text => (EVM_TX_HASH_PATTERN.test(text) ? text.toLowerCase() : undefined),
  },
  commitsHash: false,
  prunes: false,
  seen: (source, txHash) => isTxKnown(source.chain.key, txHash),
  probe: blockNumber,
  prepareSwap: prepareEvmSwap,
};

/** An EVM spoke: its deposit is the asset manager's `connection` message, its cancel the user's. */
export const EVM_SPOKE: SourceAdapter = {
  ...evm,
  async read(source, txHash) {
    if (source.kind !== "spoke") throw new Error("not a spoke");
    const receipt = await getEvmReceipt(source.chain.key, txHash);
    if (!receipt) return null;
    // A reverted tx logs nothing.
    const messages = receipt.reverted ? [] : connectionMessages(receipt, source.connection);
    return { kind: "spoke", failed: receipt.reverted, messages };
  },
  cancelStep: spokeCancelStep,
};

/** The hub: its swap tx creates the intent itself, and a cancel there cancels it. */
export const HUB: SourceAdapter = {
  ...evm,
  async read(source, txHash) {
    const receipt = await getEvmReceipt(source.chain.key, txHash);
    if (!receipt) return null;
    const logged = (topic: string) => (receipt.reverted ? [] : hubIntentHashes(receipt, source.swapContract, topic));
    const created = logged(INTENT_CREATED_TOPIC);
    return { kind: "hub", failed: receipt.reverted, created, cancelled: logged(INTENT_CANCELLED_TOPIC) };
  },
  async cancelStep(source, intent) {
    const hubTx = await hubCancelTx(intent);
    if (!hubTx) throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.");
    return cancelOf(source, hubTx);
  },
};

/**
 * The EVM steps: the Swaps API's swap tx (and any approval) checked byte for byte against the SDK's rebuild, as
 * `findEvmTxMismatch` says, then the approve and swap as one batch.
 */
async function prepareEvmSwap(
  source: SwapSource,
  { request, built, approved }: SwapToBuild,
): Promise<{ steps: SwapStep[]; batch?: SwapBatch }> {
  const tx = parseEvmTx(built.tx);
  const approval = approved ? undefined : await buildApprove(request);
  const expected = await rebuildSwapTx({
    srcChainKey: request.srcChainKey,
    srcAddress: request.srcAddress,
    token: request.inputToken,
    amount: request.inputAmount,
    intent: built.intent,
  });
  const mismatch = findEvmTxMismatch(request, source.swapContract, expected, tx, approval);
  if (mismatch) throw swapMismatch(request, mismatch, tx);
  return toSteps(tx, approval, chainIdOf(source), request.srcAddress);
}

const chainIdOf = (source: SwapSource) => {
  if (source.chainId === undefined) throw new Error("an EVM source without its chain id");
  return source.chainId;
};

/** Possibly a compromised or broken upstream: enough to investigate, no user addresses. */
export function swapMismatch(request: IntentRequest, mismatch: string, builtTx: unknown): ActionError {
  const { srcChainKey, dstChainKey } = request;
  const tx = asEvmTx(builtTx);
  const dataSha256 = tx && createHash("sha256").update(tx.data.toLowerCase()).digest("hex");
  logger.error(
    {
      mismatch,
      "chain.key": srcChainKey,
      "dst_chain.key": dstChainKey,
      ...(tx && { "tx.to": tx.to, "tx.data_sha256": dataSha256 }),
    },
    "The Swaps API built a swap that doesn't match the quote",
  );
  return new ActionError("SWAP_MISMATCH", "The swap service built a different swap than the one quoted.", {
    details: { chainKey: srcChainKey },
  });
}

/**
 * The EVM swap tx must be, byte for byte, the one the SDK builds for the checked intent, and any approval
 * `approve(the pinned swap contract, exact amount)` on the source token. Names the first check that fails.
 */
function findEvmTxMismatch(
  request: IntentRequest,
  /** The contract the swap calls: the spoke's asset manager, or the hub's intents contract. */
  swapContract: string,
  /** The SDK's rebuild of the swap tx, if it could. */
  expected: SwapTx | undefined,
  tx: EvmTx,
  approval?: Approval,
): string | undefined {
  const approves = (step: EvmTx, amount: bigint) =>
    same(step.from, request.srcAddress) &&
    same(step.to, request.inputToken) &&
    BigInt(step.value) === 0n &&
    same(step.data, approveCalldata(request.inputToken, swapContract, amount));
  const checks: [string, boolean][] = [
    ["tx.from", same(tx.from, request.srcAddress)],
    ["rebuild", expected !== undefined],
    ["tx.to", same(tx.to, expected?.to ?? "")],
    ["tx.value", BigInt(tx.value) === expected?.value],
    ["tx.data", same(tx.data, expected?.data ?? "")],
    [
      "approval",
      !approval ||
        (approves(approval.tx, request.inputAmount) && (!approval.resetTx || approves(approval.resetTx, 0n))),
    ],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
}

/**
 * Hex quantities, as `eth_sendTransaction` takes them. The chain id is in the tx: several chains share the
 * contracts a step calls, so a wallet on another network must refuse it rather than send it there.
 */
function toStepTx(tx: EvmTx, chainId: number): StepTx {
  return { ...tx, value: `0x${BigInt(tx.value).toString(16)}`, chainId: `0x${chainId.toString(16)}` };
}

/** The steps in order and, with an approval, the approve and swap as one batch. A reset stays out: it must land first. */
function toSteps(
  swapTx: EvmTx,
  approval: Approval | undefined,
  chainId: number,
  from: string,
): { steps: SwapStep[]; batch?: SwapBatch } {
  const swap: SwapStep = { kind: "swap", chainId, tx: toStepTx(swapTx, chainId) };
  if (!approval) return { steps: [swap] };
  const approve: SwapStep = { kind: "approve", chainId, tx: toStepTx(approval.tx, chainId) };
  const reset: SwapStep[] = approval.resetTx
    ? [{ kind: "reset_approve", chainId, tx: toStepTx(approval.resetTx, chainId) }]
    : [];
  return {
    steps: [...reset, approve, swap],
    batch: {
      replaces: ["approve", "swap"],
      method: "wallet_sendCalls",
      params: [
        {
          version: "2.0.0",
          chainId: `0x${chainId.toString(16)}`,
          from,
          atomicRequired: true,
        },
      ],
    },
  };
}

const cancelOf = (source: SwapSource, tx: EvmTx): CancelStep => {
  const chainId = chainIdOf(source);
  return { kind: "cancel", chainId, tx: toStepTx(tx, chainId) };
};

/**
 * An EVM spoke's cancel, built by the backend and checked before anyone signs it: from the intent's source address,
 * to the chain's `connection`, no value, sending the user's hub wallet exactly the SDK's `cancelIntent(intent)` call.
 * That payload is what the wallet runs, so nothing else may pass.
 */
async function spokeCancelStep(source: SwapSource, intent: Intent): Promise<CancelStep> {
  if (source.kind !== "spoke") throw new Error("not a spoke");
  const tx = await buildCancel(source.chain.key, intent);
  const message = decodeSendMessage(tx.data);
  const payload = cancelPayload(intent);
  if (
    !message ||
    !payload ||
    !same(tx.from, intent.srcAddress) ||
    !same(tx.to, source.connection) ||
    BigInt(tx.value) !== 0n ||
    message.dstChainId !== HUB_RELAY_ID ||
    !same(message.dstAddress, intent.creator) ||
    !same(message.payload, payload)
  ) {
    logger.error(
      { "chain.key": source.chain.key, "tx.to": tx.to },
      "The Swaps API built a cancel that doesn't match the intent",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service built a different cancel than expected.", {
      details: { chainKey: source.chain.key },
    });
  }
  return cancelOf(source, tx);
}
