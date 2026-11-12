/**
 * `sodax_swap_cancel`, in two calls: the first returns the unsigned cancel for the user's wallet,
 * the second (with `cancelTxHash`) checks it on chain and relays it to the hub, because the cancel
 * endpoint only builds the tx. The intent comes from the hub, never from the agent.
 */

import { sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import {
  buildNonEvmCancel,
  cancelPayload,
  createIntentPayload,
  decodeAddress,
  hubCancelTx,
  intentChainId,
  intentHash,
  relayNeedsData,
  userHubWallet,
} from "../sodax.js";
import { ActionError } from "./errors.js";
import { type NonEvmStep, carriesPayload, toNonEvmStep } from "./nonEvmSource.js";
import { type StepTx, toStepTx } from "./quote.js";
import { type CachedQuote, claimDeposit } from "./quoteCache.js";
import {
  type NotCancellable,
  RETRY_AFTER_SEC,
  type SourceTx,
  type SwapRef,
  type SwapSource,
  checkPinnedTarget,
  isHubSource,
  readSourceTx,
  resolveSource,
  sourceTxHash,
  whyNotCancellable,
} from "./source.js";
import { HUB_RELAY_ID, INTENT_CANCELLED_TOPIC, decodeSendMessage, holdsCancel, hubLogged } from "./sourceTx.js";
import { type EvmTx, type Intent, buildCancel, getHubIntent, getSubmitTxStatus, relaySpokeTx } from "./swapsApi.js";
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

/** What the user's wallet sends to cancel: an EVM tx, or a non-EVM spoke's raw tx. */
export type CancelStep = { kind: "cancel"; chainId: number; tx: StepTx } | NonEvmStep;

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
  if (receipt?.reverted) return { ...base, status: "cancel_failed" };

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
  if (!receipt || !cancelTxHash) return { ...base, status: "ready", steps: [await cancelStep(source, intent)] };
  if (receipt.family === "EVM" && isHubSource(receipt.source)) {
    const cancelled = hubLogged(
      receipt.receipt,
      receipt.source.swapContract,
      INTENT_CANCELLED_TOPIC,
      intentHash(intent),
    );
    return { ...base, status: cancelled ? "cancel_confirmed" : "not_a_cancel_tx" };
  }
  // The payload the sent cancel must carry, built here: a Swaps API outage can't hold up a mined cancel.
  const payload = cancelPayload(intent);
  if (!payload) throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.");
  if (!holdsIntentCancel(receipt, intent, payload, decodeAddress(source.chain.key, intent.srcAddress))) {
    return { ...base, status: "not_a_cancel_tx" };
  }
  const data = relayNeedsData(source.chain.key) ? { address: intent.creator, payload } : undefined;
  if (!(await relaySpokeTx(intent.srcChain, cancelTxHash, data))) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX relay didn't take the cancel.");
  }
  return { ...base, status: "cancel_relayed" };
}

/**
 * Whether a spoke tx is the intent's cancel: on an EVM spoke, the `connection` message from the intent's source
 * address to its creator with exactly `payload`; on a non-EVM one, a tx carrying `payload` (Solana: its keccak),
 * which the relay reads, or on Solana checks against, before anything reaches the hub.
 */
function holdsIntentCancel(sourceTx: SourceTx, intent: Intent, payload: string, sender?: string): boolean {
  if (sourceTx.family !== "EVM") {
    const { signer } = sourceTx.tx;
    return carriesPayload(sourceTx.tx, payload, sourceTx.family) && (signer === undefined || signer === sender);
  }
  const { connection } = sourceTx.source;
  if (!connection) return false;
  return holdsCancel(sourceTx.receipt, {
    connection,
    srcAddress: intent.srcAddress,
    srcChain: intent.srcChain,
    creator: intent.creator,
    payload,
  });
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
  if (!receipt || receipt.reverted) return { ...base, status: "not_cancellable", reason: "not_sent" };
  if (checkQuoteDeposit(receipt, quote) !== "match") return undefined;
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
    if (source.family === "EVM") throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't read ${name} right now.`);
    throw new ActionError("QUOTE_NOT_FOUND", `Without its quote, this server can't check this swap on ${name}.`, {
      nextStep: `${name}'s node no longer has the swap's transaction. Call sodax_swap_cancel again with its quoteId if the user has it; if not, tell the user this server can't cancel it, that it is safe on the SODAX hub, and to give SODAX support its transaction hash.`,
    });
  }
  // As track checks a quote's: alone in its tx.
  const swap = { intent, srcAddress: sender, relayData: { address: intent.creator, payload } };
  if (checkQuoteDeposit(receipt, swap) !== "match") return false;
  const hubWallet = await userHubWallet(source.chain.key, sender).catch(() => {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "Couldn't look up the user's SODAX hub wallet.");
  });
  return same(hubWallet, intent.creator);
}

/** The intent fields that differ; hex in any case is the same value. */
function differingFields(quoted: Intent, hub: Intent): (keyof Intent)[] {
  return (Object.keys(quoted) as (keyof Intent)[]).filter(field => !same(String(quoted[field]), String(hub[field])));
}

/**
 * The cancel step, checked or built before anyone signs it. From an EVM spoke the backend builds it, and it must be
 * from the intent's source address, to the chain's `connection`, no value, sending the user's hub wallet exactly
 * the SDK's `cancelIntent(intent)` call: that payload is what the wallet runs, so nothing else may pass. From the
 * hub (the wallet router runs that call) and from a non-EVM spoke the SDK builds it here, as its own clients do.
 */
async function cancelStep(source: SwapSource, intent: Intent): Promise<CancelStep> {
  if (source.family !== "EVM") {
    const { chain } = source;
    const raw = await buildNonEvmCancel(chain.key, intent).catch(() => {
      throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't prepare the cancel on ${chain.name} right now.`);
    });
    checkPinnedTarget(chain.key, "cancel", raw);
    return toNonEvmStep("cancel", source.family, chain.key, raw);
  }
  const step = (tx: EvmTx): CancelStep => ({
    kind: "cancel",
    chainId: source.chainId,
    tx: toStepTx(tx, source.chainId),
  });
  const { connection } = source;
  if (!connection) {
    const hubTx = await hubCancelTx(intent);
    if (!hubTx) throw new ActionError("INTERNAL", "Couldn't work out the cancel this swap needs.");
    return step(hubTx);
  }
  const tx = await buildCancel(source.chain.key, intent);
  const message = decodeSendMessage(tx.data);
  const payload = cancelPayload(intent);
  if (
    !message ||
    !payload ||
    !same(tx.from, intent.srcAddress) ||
    !same(tx.to, connection) ||
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
  return step(tx);
}
