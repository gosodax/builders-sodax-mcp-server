/**
 * What follows each bridge tool result, as `nextAction` and the `nextStep` sentence that says the same, built by one
 * decision so the two can't disagree. Failures go through the swap tools' `errorDecision`, which handles the bridge's
 * own codes.
 */

import type { BridgePairs } from "../services/bridge/pair.js";
import type { BridgePreview, BridgeQuote } from "../services/bridge/prepare.js";
import type { BridgeTrack } from "../services/bridge/track.js";
import { isHubChain } from "../services/sodax.js";
import { addressAsk } from "../services/swap/quote.js";
import {
  type ConfirmSummary,
  type Decision,
  type Exhausted,
  NONE,
  callOnce,
  callRepeated,
  exhausted,
  external,
  final,
  ongoing,
  provide,
} from "./nextAction.js";
import { SEND_BATCH, SIGN_NON_EVM_TX, approveOf, sendsToOwnAddressElsewhere } from "./swapDecisions.js";

const TRACK = "sodax_bridge_submit_and_track";
const PREPARE = "sodax_bridge_prepare";

/** What bridges between two chains answers on its own; the user picks a pair to preview or prepare. */
export function pairsDecision({ from, to, pairs }: BridgePairs): Decision {
  if (pairs.length === 0) {
    return final(`Nothing on ${from.name} bridges to ${to.name}: ask the user which other chain to bridge to.`, NONE);
  }
  const listed = pairs.map(pair => `${pair.from.symbol} to ${pair.to.symbol}`).join(", ");
  return final(
    `From ${from.name} to ${to.name}, these bridge: ${listed}. Pass the pair the user picks, by its addresses, as fromToken and toToken to sodax_bridge_preview or sodax_bridge_prepare.`,
    NONE,
  );
}

/** A preview asks for what preparing needs, then prepares with the same arguments. */
export function previewDecision(preview: BridgePreview): Decision {
  const { from, to, partnerFee, maxAmount, prepareNeeds } = preview;
  const fee = partnerFee ? `, including a ${partnerFee.amount} ${partnerFee.symbol} partner fee,` : "";
  const needed = prepareNeeds.map(field => addressAsk(field, from.chain.name, to.chain.name));
  return ongoing(
    `Show the user they would send ${from.amount} ${from.symbol} on ${from.chain.name}${fee} and receive ${to.amount} ${to.symbol} on ${to.chain.name}; at most ${maxAmount} ${from.symbol} can be bridged on this route now. Once the user is ready to sign, call ${PREPARE} with the same arguments plus ${needed.join(" and ")}.`,
    provide(prepareNeeds, callOnce(PREPARE, "same")),
  );
}

function prepareNextStep(quote: BridgeQuote): string {
  const { from, to, partnerFee } = quote;
  const fee = partnerFee ? `, including a ${partnerFee.amount} ${partnerFee.symbol} partner fee,` : "";
  const show = `Show the user they send ${from.amount} ${from.symbol} on ${from.chain.name}${fee} and receive ${to.amount} ${to.symbol} on ${to.chain.name} at ${quote.toAddress}`;
  const sameAddress = sendsToOwnAddressElsewhere(quote)
    ? ` (the sender's own address: make sure they control it on ${to.chain.name})`
    : "";
  const [first] = quote.steps;
  const allowance = approveOf(quote);
  const approve = allowance
    ? ` Tell them the approve lets ${allowance.spender}, the SODAX bridge's spender, spend ${allowance.amount} ${allowance.symbol} of theirs.`
    : "";
  const send =
    "chainType" in first
      ? `Once they confirm, have their ${from.chain.name} wallet send the bridge step before it expires: ${SIGN_NON_EVM_TX[first.chainType]}.`
      : `Their wallet must be on ${from.chain.name} (chain id ${first.chainId}) to send the steps; switch it there first if it isn't.${approve} Once they confirm, have their wallet send the steps in order before they expire, each mined before the next (a bridge sent before its approve is mined fails)${quote.batch ? SEND_BATCH : ""}.`;
  return [
    `${show}${sameAddress}; the steps expire at ${quote.expiresAt}.`,
    "Balances aren't checked here; sodax_get_balance with for: bridge reads them.",
    send,
    "Then call sodax_bridge_submit_and_track with the bridgeId and the bridge transaction's hash, even if the steps have expired by then: that call is what submits the bridge.",
  ].join(" ");
}

/** A ready bridge is shown to the user, signed in order, and tracked from the moment its last step is broadcast. */
export function prepareDecision(quote: BridgeQuote): Decision {
  const { from, to, partnerFee } = quote;
  const allowance = approveOf(quote);
  const summary: ConfirmSummary = {
    kind: "bridge",
    bridgeId: quote.bridgeId,
    expiresAt: quote.expiresAt,
    send: { amount: from.amount, symbol: from.symbol, chain: from.chain.key },
    receive: { amount: to.amount, symbol: to.symbol, chain: to.chain.key },
    recipient: quote.toAddress,
    ...(partnerFee && { partnerFee }),
    ...(allowance && { approve: { spender: allowance.spender, amount: allowance.amount, symbol: allowance.symbol } }),
  };
  // The chain too, so a bridge whose record this server lost is still found from its deposit.
  const afterSend = {
    ...callOnce(TRACK, { bridgeId: quote.bridgeId, chain: from.chain.key }),
    on: "broadcast" as const,
    needs: ["txHash"] as ["txHash"],
  };
  return ongoing(prepareNextStep(quote), {
    type: "confirm",
    summary,
    next: {
      type: "execute",
      chain: from.chain.key,
      stepsAt: "steps",
      ...(quote.batch && { batchAt: "batch" as const }),
      waitFor: "receipt_success",
      expiresAt: quote.expiresAt,
      afterSend,
    },
  });
}

// Polls of one bridge stage, about 10 minutes at 20 seconds apart; a bridge still moving then is a person's to watch.
const MAX_POLLS = 30;

/** What follows a tracked bridge: wait while it moves, stop where it ended, and hand a stuck one to a person. */
export function trackDecision(result: BridgeTrack): Decision {
  const { txHash, chain } = result;
  const again = (afterSec: number, stage: string, onExhausted: Exhausted) =>
    callRepeated(
      callOnce(TRACK, "same", afterSec),
      { maxAttempts: MAX_POLLS, retryKey: `${TRACK}:${chain.key}:${txHash}:${stage}` },
      onExhausted,
    );
  const stillMoving = exhausted(external("still_in_progress"), false);
  const helpDesk = `give the transaction hash ${txHash} and this result's requestId to the SODAX team`;
  switch (result.status) {
    case "awaiting_source":
      return ongoing(
        `The bridge transaction isn't mined on ${chain.name} yet${result.seenOnChain ? " (its node has it)" : ""}. Call again in 15 seconds; the user must not send it again meanwhile.`,
        again(15, "source", exhausted(external("check_wallet"), false)),
      );
    case "source_failed":
      return final(
        `The bridge transaction failed on ${chain.name}: nothing was bridged, only its gas was spent. The user can prepare a new bridge.`,
        NONE,
        "failed",
      );
    case "not_submitted":
      if (result.reason === "not_this_bridge") {
        return ongoing(
          `That transaction on ${chain.name} isn't this bridge's deposit. Ask the user for the hash of the bridge step their wallet sent (not the approve's), then call again with it.`,
          provide(["txHash"], callOnce(TRACK, "same")),
        );
      }
      return final(
        `This server can't submit that bridge (${result.reason.replaceAll("_", " ")}). Tell the user not to send it again, and to ${helpDesk}.`,
        external("help_desk"),
        "unknown",
      );
    case "relaying":
      return ongoing(
        "The bridge is on its way to the SODAX hub. Call again in 20 seconds; the user must not send it again.",
        again(20, "relay", stillMoving),
      );
    case "relay_failed":
      return final(
        `${
          isHubChain(chain.key)
            ? `The bridge left ${chain.name}, but the relay gave up before the destination chain: the tokens aren't lost, and wait for the SODAX team to relay them.`
            : `The relay gave up before the SODAX hub: the tokens are held by the SODAX asset manager on ${chain.name}, not lost, until the SODAX team relays them.`
        } Tell the user not to send it again, and to ${helpDesk}.`,
        external("help_desk"),
        "held",
      );
    case "in_transit":
      return ongoing(
        "The SODAX hub ran the bridge and sent the tokens on to the destination chain. Call again in 20 seconds.",
        again(20, "transit", stillMoving),
      );
    case "delivered":
      return final(
        result.delivery === "sent"
          ? `The bridge was sent to the recipient (destination tx ${result.dstTxHash}); that chain has yet to run it.`
          : `The bridge arrived: the recipient has the tokens (destination tx ${result.dstTxHash}).`,
        NONE,
        "succeeded",
      );
    case "held_on_hub":
      return final(
        `The bridge reached the SODAX hub but its calls failed there, so the tokens are in the user's hub wallet on Sonic, not lost. They can withdraw them to their wallet on ${chain.name} with the SODAX SDK's RecoveryService.withdrawHubAsset${result.recovery ? " (recovery's chain, address and token, and at most this bridge's amount, as fetchHubAssetBalances reads it)" : ""}, or ${helpDesk}.`,
        external("help_desk"),
        "held",
      );
  }
}
