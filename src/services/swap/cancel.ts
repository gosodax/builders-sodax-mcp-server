/**
 * `sodax_swap_cancel`, in two calls: the first returns the unsigned cancel for the user's wallet,
 * the second (with `cancelTxHash`) checks it on chain and relays it to the hub, because the cancel
 * endpoint only builds the tx. The intent comes from the hub, never from the agent.
 */

import { sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import {
  cancelPayload,
  createIntentPayload,
  decodeAddress,
  intentChainId,
  intentHash,
  userHubWallet,
} from "../sodax.js";
import { ActionError } from "./errors.js";
import { type CachedQuote, claimDeposit } from "./quoteCache.js";
import {
  type NotCancellable,
  RETRY_AFTER_SEC,
  type SwapRef,
  committedPayload,
  isHubSource,
  readSourceTx,
  resolveSource,
  sourceTxHash,
  whyNotCancellable,
} from "./source.js";
import { holdsCancel } from "./sourceTx.js";
import type { CancelStep, SwapSource } from "./sources/types.js";
import { type Intent, getHubIntent, getSubmitTxStatus, relaySpokeTx } from "./swapsApi.js";
import { checkQuoteDeposit, deadlineMs, relayForRefund, untilRefundSec } from "./track.js";

export type CancelState =
  | { status: "not_cancellable"; reason: NotCancellable | "not_sent" }
  /** The quote's deposit is on chain, never submitted: from its deadline on, a cancel call refunds it. */
  | { status: "deposit_unsubmitted"; retryAfterSec: number }
  /** That refund's relay failed; the next call tries again. */
  | { status: "expired_unsubmitted"; alerted: boolean; retryAfterSec: number }
  | { status: "ready"; steps: [CancelStep] }
  | { status: "cancel_awaiting_confirmation"; retryAfterSec: number }
  | { status: "cancel_failed" }
  | { status: "not_a_cancel_tx" }
  | { status: "cancel_relayed" }
  /** A swap from the hub: the cancel ran there, so nothing is relayed. */
  | { status: "cancel_confirmed" };

export type CancelResult = SwapRef & CancelState;

export async function cancelSwap(input: {
  txHash: string;
  quoteId?: string;
  chain?: string;
  cancelTxHash?: string;
}): Promise<CancelResult> {
  const source = await resolveSource(input);
  const txHash = sourceTxHash(source, input.txHash);
  const { quote } = source;
  const base: SwapRef = {
    txHash,
    chain: source.chain,
    ...(input.quoteId && { quoteId: input.quoteId }),
    ...(quote && { intentHash: intentHash(quote.intent) }),
  };
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

  const cancelTxHash = input.cancelTxHash && sourceTxHash(source, input.cancelTxHash, "cancelTxHash");
  const receipt = cancelTxHash ? await readSourceTx(source, cancelTxHash, quote?.srcAddress) : undefined;
  if (receipt === null) return { ...base, status: "cancel_awaiting_confirmation", retryAfterSec: RETRY_AFTER_SEC };
  if (receipt?.failed) return { ...base, status: "cancel_failed" };

  const intent = await getHubIntent(hubTxHash);
  const differs = quote ? differingFields(quote.intent, intent) : [];
  if (differs.length > 0) {
    logger.error(
      { "chain.key": source.chain.key, "quote.id": quote?.quoteId, fields: differs },
      "The hub intent isn't the quoted one",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service returned a different intent than the one quoted.", {
      details: { chainKey: source.chain.key },
    });
  }
  if (!quote && !(await isDepositsIntent(source, txHash, intent))) {
    logger.error({ "chain.key": source.chain.key }, "The hub intent isn't the tracked deposit's");
    throw new ActionError("SWAP_MISMATCH", "The swap service returned an intent that isn't this deposit's.", {
      details: { chainKey: source.chain.key },
    });
  }
  // From the hub (the wallet router runs the call) and from a non-EVM spoke the SDK builds it, as its own clients do;
  // from an EVM spoke the backend does, and the build is checked before anyone signs it.
  if (!receipt || !cancelTxHash) {
    return { ...base, status: "ready", steps: [await source.adapter.cancelStep(source, intent)] };
  }
  if (receipt.kind === "hub") {
    const hash = intentHash(intent);
    const cancelled = receipt.cancelled.some(logged => same(logged, hash));
    return { ...base, status: cancelled ? "cancel_confirmed" : "not_a_cancel_tx" };
  }
  // The payload the sent cancel must carry, built here: a Swaps API outage can't hold up a mined cancel.
  const payload = cancelPayload(intent);
  if (!payload) throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.");
  // The user's own message to their hub wallet, as the relay will read it: only that cancels the intent.
  const cancel = {
    srcAddress: intent.srcAddress,
    srcChain: intent.srcChain,
    creator: intent.creator,
    payload: committedPayload(source, payload),
  };
  if (!holdsCancel(receipt.messages, cancel)) return { ...base, status: "not_a_cancel_tx" };
  const data = source.adapter.commitsHash ? { address: intent.creator, payload } : undefined;
  if (!(await relaySpokeTx(intent.srcChain, cancelTxHash, data))) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX relay didn't take the cancel.");
  }
  return { ...base, status: "cancel_relayed" };
}

/**
 * A quote's tx with no backend row: nothing reached the hub to cancel. Its deposit stays on chain unswapped;
 * only track would submit it, and from its deadline on it's refunded as track does. `undefined`
 * for a mined tx that isn't this quote's deposit, which track reports on.
 */
async function unsubmittedDeposit(
  base: SwapRef,
  source: SwapSource,
  quote: CachedQuote,
): Promise<CancelResult | undefined> {
  const receipt = await readSourceTx(source, base.txHash, quote.srcAddress);
  if (!receipt || receipt.failed) return { ...base, status: "not_cancellable", reason: "not_sent" };
  if (checkQuoteDeposit(source, receipt, quote) !== "match") return undefined;
  if (Date.now() < deadlineMs(quote)) {
    return { ...base, status: "deposit_unsubmitted", retryAfterSec: untilRefundSec(quote) };
  }
  if (claimDeposit(quote.quoteId, base.txHash) !== "claimed") return undefined;
  const refund = await relayForRefund(base, quote, source);
  return refund.status === "expired_refunding" ? { ...base, status: "not_cancellable", reason: "refunding" } : refund;
}

const quoteMismatch = (message: string) =>
  new ActionError("QUOTE_MISMATCH", message, {
    nextStep: "Call again with the quoteId this transaction was made from, or with chain instead of quoteId.",
  });

/**
 * Without a quote, the hub intent must be the tracked swap's: from this chain, and alone in that tx, either a
 * deposit by the intent's source address to its creator with the calls that create this very intent, or on the
 * hub the intents contract's log of it. The creator must be that address's hub wallet, so its cancel reaches it.
 */
async function isDepositsIntent(source: SwapSource, txHash: string, intent: Intent): Promise<boolean> {
  if (intent.srcChain !== intentChainId(source.chain.key)) return false;
  // A deposit must carry the calls that create this intent; a hub swap is matched by the intent's hash alone.
  const payload = isHubSource(source) ? "" : createIntentPayload(intent);
  // The SDK takes the sender as its chain spells it; the intent holds it encoded.
  const sender = decodeAddress(source.chain.key, intent.srcAddress);
  if (payload === undefined || sender === undefined) return false;
  const receipt = await readSourceTx(source, txHash, sender);
  if (!receipt) {
    const { name } = source.chain;
    // The deposit reached the hub, so it's mined: an EVM node without its receipt is behind, while a public non-EVM
    // node drops older txs for good, and calling again won't help.
    if (!source.adapter.prunes) throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't read ${name} right now.`);
    throw new ActionError("QUOTE_NOT_FOUND", `Without its quote, this server can't check this swap on ${name}.`, {
      nextStep: `${name}'s node no longer has the swap's transaction. Call sodax_swap_cancel again with its quoteId if the user has it; if not, tell the user this server can't cancel it, that it is safe on the SODAX hub, and to give SODAX support its transaction hash.`,
    });
  }
  // As track checks a quote's: alone in its tx.
  const swap = { intent, relayData: { address: intent.creator, payload } };
  if (checkQuoteDeposit(source, receipt, swap) !== "match") return false;
  const hubWallet = await userHubWallet(source.chain.key, sender).catch(() => {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "Couldn't look up the user's SODAX hub wallet.");
  });
  return same(hubWallet, intent.creator);
}

/** The intent fields that differ; hex in any case is the same value. */
function differingFields(quoted: Intent, hub: Intent): (keyof Intent)[] {
  return (Object.keys(quoted) as (keyof Intent)[]).filter(field => !same(String(quoted[field]), String(hub[field])));
}
