/**
 * `sodax_swap_cancel`, in two calls: the first returns the unsigned cancel for the user's wallet,
 * the second (with `cancelTxHash`) checks it on chain and relays it to the hub, because the cancel
 * endpoint only builds the tx. The intent comes from the hub, never from the agent.
 */

import { sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import { ActionError } from "./errors.js";
import { toStepTx } from "./quote.js";
import {
  type NotCancellable,
  RETRY_AFTER_SEC,
  type SwapRef,
  type SwapSource,
  readReceipt,
  resolveSource,
  whyNotCancellable,
} from "./source.js";
import { HUB_RELAY_ID, decodeSendMessage, holdsCancel } from "./sourceTx.js";
import { type EvmTx, type Intent, buildCancel, getHubIntent, getSubmitTxStatus, relaySpokeTx } from "./swapsApi.js";

export type CancelState =
  | { status: "not_cancellable"; reason: NotCancellable }
  | { status: "ready"; steps: [{ kind: "cancel"; chainId: number; tx: EvmTx }] }
  | { status: "cancel_awaiting_confirmation"; retryAfterSec: number }
  | { status: "cancel_failed" }
  | { status: "not_a_cancel_tx" }
  | { status: "cancel_relayed" };

export type CancelResult = SwapRef & CancelState;

export async function cancelSwap(input: {
  txHash: string;
  quoteId?: string;
  chain?: string;
  cancelTxHash?: string;
}): Promise<CancelResult> {
  const txHash = input.txHash.toLowerCase();
  const source = await resolveSource(input);
  const base: SwapRef = { txHash, chain: source.chain, ...(input.quoteId && { quoteId: input.quoteId }) };

  // Until the sent cancel is mined, nothing upstream is worth asking.
  const cancelTxHash = input.cancelTxHash?.toLowerCase();
  const receipt = cancelTxHash ? await readReceipt(source.chain, cancelTxHash) : undefined;
  if (receipt === null) return { ...base, status: "cancel_awaiting_confirmation", retryAfterSec: RETRY_AFTER_SEC };
  if (receipt?.reverted) return { ...base, status: "cancel_failed" };

  const row = await getSubmitTxStatus(txHash, source.chain.key);
  const hubTxHash = row?.result?.dstIntentTxHash;
  const reason = whyNotCancellable(row);
  if (reason || !hubTxHash) return { ...base, status: "not_cancellable", reason: reason ?? "not_on_hub_yet" };

  const intent = await getHubIntent(hubTxHash);
  if (source.quote && source.quote.intent.intentId !== intent.intentId) {
    logger.error({ chainKey: source.chain.key, quoteId: source.quote.quoteId }, "The hub intent isn't the quoted one");
    throw new ActionError("SWAP_MISMATCH", "The swap service returned a different intent than the one quoted.");
  }
  // The build is deterministic, so on the second call it gives the payload the sent cancel must carry.
  const { tx, payload } = await buildCheckedCancel(source, intent);
  if (!receipt || !cancelTxHash) {
    return { ...base, status: "ready", steps: [{ kind: "cancel", chainId: source.chainId, tx: toStepTx(tx) }] };
  }

  const isCancel = holdsCancel(receipt, {
    connection: source.connection,
    srcAddress: intent.srcAddress,
    srcChain: intent.srcChain,
    creator: intent.creator,
    payload,
  });
  if (!isCancel) return { ...base, status: "not_a_cancel_tx" };
  if (!(await relaySpokeTx(intent.srcChain, cancelTxHash))) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX relay didn't take the cancel.");
  }
  return { ...base, status: "cancel_relayed" };
}

/**
 * The cancel the backend builds, checked before anyone signs it: from the intent's source address,
 * to the chain's `connection`, no value, sending a message to the user's hub wallet.
 */
async function buildCheckedCancel(source: SwapSource, intent: Intent): Promise<{ tx: EvmTx; payload: string }> {
  const tx = await buildCancel(source.chain.key, intent);
  const message = decodeSendMessage(tx.data);
  if (
    !message ||
    !same(tx.from, intent.srcAddress) ||
    !same(tx.to, source.connection) ||
    BigInt(tx.value) !== 0n ||
    message.dstChainId !== HUB_RELAY_ID ||
    !same(message.dstAddress, intent.creator)
  ) {
    logger.error(
      { chainKey: source.chain.key, txTo: tx.to },
      "The Swaps API built a cancel that doesn't match the intent",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service built a different cancel than expected.");
  }
  return { tx, payload: message.payload };
}
