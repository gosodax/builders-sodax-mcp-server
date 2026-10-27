/**
 * `sodax_swap_cancel`, in two calls: the first returns the unsigned cancel for the user's wallet,
 * the second (with `cancelTxHash`) checks it on chain and relays it to the hub, because the cancel
 * endpoint only builds the tx. The intent comes from the hub, never from the agent.
 */

import { sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import { cancelPayload, intentChainId, userHubWallet } from "../sodax.js";
import { ActionError } from "./errors.js";
import { type StepTx, toStepTx } from "./quote.js";
import { type CachedQuote, claimDeposit } from "./quoteCache.js";
import {
  type NotCancellable,
  RETRY_AFTER_SEC,
  type SwapRef,
  type SwapSource,
  readReceipt,
  resolveSource,
  whyNotCancellable,
} from "./source.js";
import { HUB_RELAY_ID, decodeSendMessage, holdsCancel, holdsDeposit } from "./sourceTx.js";
import { type EvmTx, type Intent, buildCancel, getHubIntent, getSubmitTxStatus, relaySpokeTx } from "./swapsApi.js";
import { checkQuoteDeposit, deadlineMs, relayForRefund, untilRefundSec } from "./track.js";

export type CancelState =
  | { status: "not_cancellable"; reason: NotCancellable | "not_sent" }
  /** The quote's deposit is on chain, never submitted: from its deadline on, a cancel call refunds it. */
  | { status: "deposit_unsubmitted"; retryAfterSec: number }
  /** That refund's relay failed; the next call tries again. */
  | { status: "expired_unsubmitted"; alerted: true; retryAfterSec: number }
  | { status: "ready"; steps: [{ kind: "cancel"; chainId: number; tx: StepTx }] }
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
    throw quoteMismatch("That quote was used by another transaction.");
  }

  // The swap first: a sent cancel is only worth waiting for if there's something to cancel.
  const row = await getSubmitTxStatus(txHash, source.chain.key);
  // A deposit this server relayed for refund has no backend row; its quote is the record.
  if (!row && quote?.handedOver === "relayed_for_refund" && quote.depositTxHash === txHash) {
    return { ...base, status: "not_cancellable", reason: "refunding" };
  }
  if (!row && quote && !quote.handedOver) {
    const unsubmitted = await unsubmittedDeposit(base, source, quote);
    if (unsubmitted) return unsubmitted;
  }
  const hubTxHash = row?.result?.dstIntentTxHash;
  const reason = whyNotCancellable(row);
  if (reason || !hubTxHash) return { ...base, status: "not_cancellable", reason: reason ?? "not_on_hub_yet" };
  // Only a deposit track checked is the quote's: any other tx's intent says nothing about it.
  if (quote && quote.depositTxHash !== txHash) {
    throw quoteMismatch("That quote has no checked deposit in this transaction.");
  }

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
    throw new ActionError("SWAP_MISMATCH", "The swap service returned a different intent than the one quoted.", {
      details: { chainKey: source.chain.key },
    });
  }
  if (!quote && !(await isDepositsIntent(source, txHash, intent))) {
    logger.error({ chainKey: source.chain.key }, "The hub intent isn't the tracked deposit's");
    throw new ActionError("SWAP_MISMATCH", "The swap service returned an intent that isn't this deposit's.", {
      details: { chainKey: source.chain.key },
    });
  }
  if (!receipt || !cancelTxHash) {
    const { tx } = await buildCheckedCancel(source, intent);
    return {
      ...base,
      status: "ready",
      steps: [{ kind: "cancel", chainId: source.chainId, tx: toStepTx(tx, source.chainId) }],
    };
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

/**
 * A quote's tx with no backend row: nothing reached the hub to cancel. Its deposit stays on chain unswapped;
 * only track would submit it, and from its deadline on it's relayed for refund as track does. `undefined`
 * for a mined tx that isn't this quote's deposit, which track reports on.
 */
async function unsubmittedDeposit(
  base: SwapRef,
  source: SwapSource,
  quote: CachedQuote,
): Promise<CancelResult | undefined> {
  const receipt = await readReceipt(source.chain, base.txHash);
  if (!receipt || receipt.reverted) return { ...base, status: "not_cancellable", reason: "not_sent" };
  if (checkQuoteDeposit(receipt, source, quote) !== "match") return undefined;
  if (Date.now() < deadlineMs(quote)) {
    return { ...base, status: "deposit_unsubmitted", retryAfterSec: untilRefundSec(quote) };
  }
  if (claimDeposit(quote.quoteId, base.txHash) !== "claimed") return undefined;
  const refund = await relayForRefund(base, quote);
  return refund.status === "expired_refunding" ? { ...base, status: "not_cancellable", reason: "refunding" } : refund;
}

const quoteMismatch = (message: string) =>
  new ActionError("QUOTE_MISMATCH", message, {
    nextStep: "Call again with the quoteId this transaction was made from, or with chain instead of quoteId.",
  });

/**
 * Without a quote, the hub intent must be the tracked deposit's: from this chain, created by the hub
 * wallet of an address that deposited to it in that tx, so that address's cancel reaches it.
 */
async function isDepositsIntent(source: SwapSource, txHash: string, intent: Intent): Promise<boolean> {
  if (intent.srcChain !== intentChainId(source.chain.key)) return false;
  const receipt = await readReceipt(source.chain, txHash);
  // The deposit reached the hub, so it's mined: a node without its receipt is behind.
  if (!receipt) throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't read ${source.chain.name} right now.`);
  const { connection, assetManager } = source;
  const want = { connection, assetManager, srcChain: intent.srcChain, from: intent.srcAddress, to: intent.creator };
  if (!holdsDeposit(receipt, want)) return false;
  const hubWallet = await userHubWallet(source.chain.key, intent.srcAddress).catch(() => {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "Couldn't look up the user's SODAX hub wallet.");
  });
  return same(hubWallet, intent.creator);
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
    throw new ActionError("SWAP_MISMATCH", "The swap service built a different cancel than expected.", {
      details: { chainKey: source.chain.key },
    });
  }
  return { tx, payload };
}
