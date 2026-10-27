/**
 * `sodax_swap_cancel`, in two calls: the first returns the unsigned cancel for the user's wallet,
 * the second (with `cancelTxHash`) checks it on chain and relays it to the hub, because the cancel
 * endpoint only builds the tx. The intent comes from the hub, never from the agent.
 */

import { sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import { cancelPayload } from "../sodax.js";
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
  const { quote } = source;
  const base: SwapRef = { txHash, chain: source.chain, ...(input.quoteId && { quoteId: input.quoteId }) };
  // The caller mixed up two swaps: this quote's deposit is another tx.
  if (quote?.depositTxHash !== undefined && quote.depositTxHash !== txHash) {
    throw new ActionError("QUOTE_MISMATCH", "That quote was used by another transaction.", {
      nextStep: "Call again with the quoteId this transaction was made from, or with chain instead of quoteId.",
    });
  }

  // The swap first: a sent cancel is only worth waiting for if there's something to cancel.
  const row = await getSubmitTxStatus(txHash, source.chain.key);
  // A deposit this server relayed for refund has no backend row; its quote is the record.
  if (!row && quote?.handedOver === "relayed_for_refund" && quote.depositTxHash === txHash) {
    return { ...base, status: "not_cancellable", reason: "refunding" };
  }
  const hubTxHash = row?.result?.dstIntentTxHash;
  const reason = whyNotCancellable(row);
  if (reason || !hubTxHash) return { ...base, status: "not_cancellable", reason: reason ?? "not_on_hub_yet" };

  const cancelTxHash = input.cancelTxHash?.toLowerCase();
  const receipt = cancelTxHash ? await readReceipt(source.chain, cancelTxHash) : undefined;
  if (receipt === null) return { ...base, status: "cancel_awaiting_confirmation", retryAfterSec: RETRY_AFTER_SEC };
  if (receipt?.reverted) return { ...base, status: "cancel_failed" };

  const intent = await getHubIntent(hubTxHash);
  const differs = quote ? differingFields(quote.intent, intent) : [];
  if (differs.length > 0) {
    logger.error(
      { chainKey: source.chain.key, quoteId: quote?.quoteId, fields: differs },
      "The hub intent isn't the quoted one",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service returned a different intent than the one quoted.");
  }
  if (!receipt || !cancelTxHash) {
    const { tx } = await buildCheckedCancel(source, intent);
    return { ...base, status: "ready", steps: [{ kind: "cancel", chainId: source.chainId, tx: toStepTx(tx) }] };
  }
  // The payload the sent cancel must carry, built here: a Swaps API outage can't hold up a mined cancel.
  const payload = cancelPayload(intent);
  if (!payload) throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.");

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

/** The intent fields that differ; hex in any case is the same value. */
function differingFields(quoted: Intent, hub: Intent): (keyof Intent)[] {
  return (Object.keys(quoted) as (keyof Intent)[]).filter(field => !same(String(quoted[field]), String(hub[field])));
}

/**
 * The cancel the backend builds, checked before anyone signs it: from the intent's source address,
 * to the chain's `connection`, no value, sending the user's hub wallet exactly the SDK's
 * `cancelIntent(intent)` call. The payload is what that wallet runs, so nothing else may pass.
 */
async function buildCheckedCancel(source: SwapSource, intent: Intent): Promise<{ tx: EvmTx; payload: string }> {
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
      { chainKey: source.chain.key, txTo: tx.to },
      "The Swaps API built a cancel that doesn't match the intent",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service built a different cancel than expected.");
  }
  return { tx, payload };
}
