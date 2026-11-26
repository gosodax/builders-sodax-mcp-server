/**
 * What follows each bridge tool result, as `nextAction` and the `nextStep` sentence that says the same, built by one
 * decision so the two can't disagree. Failures go through the swap tools' `errorDecision`, which handles the bridge's
 * own codes.
 */

import type { BridgeDestinations, BridgePairs } from "../services/bridge/pair.js";
import type { BridgePreview, BridgeQuote, PartnerFeeAmount } from "../services/bridge/prepare.js";
import type { BridgeTrack } from "../services/bridge/track.js";
import { isHubChain } from "../services/sodax.js";
import { addressAsk } from "../services/swap/quote.js";
import { trackWait } from "../services/trackWait.js";
import {
  type ConfirmSummary,
  type Decision,
  NONE,
  callOnce,
  callRepeated,
  choose,
  exhausted,
  external,
  final,
  ongoing,
  provide,
} from "./nextAction.js";
import {
  SEND_BATCH,
  SIGN_NON_EVM_TX,
  approveOf,
  askTxHash,
  sendsToOwnAddressElsewhere,
  walletFirst,
} from "./swapDecisions.js";

const TOKENS = "sodax_bridge_tokens";
const TRACK = "sodax_bridge_submit_and_track";
const PREVIEW = "sodax_bridge_preview";
const PREPARE = "sodax_bridge_prepare";

type Sides = { from: { symbol: string }; to: { symbol: string } };

const hasFee = (fee: PartnerFeeAmount) => fee.amount !== "0";
const feeText = (fee: PartnerFeeAmount) =>
  hasFee(fee) ? `, including a ${fee.amount} ${fee.symbol} partner fee,` : "";
/** A pair whose symbols differ arrives as another token: the user hears it before choosing or signing. */
const tokenChange = ({ from, to }: Sides) =>
  from.symbol === to.symbol ? "" : ` (${to.symbol} is a different token from ${from.symbol})`;

/** What else the user pays: no fee of the bridge's own, and the source chain's gas, which the wallet sets. */
const costs = ({ partnerFee, networkFee, from }: BridgePreview | BridgeQuote) =>
  `The bridge charges no fee of its own${hasFee(partnerFee) ? " beyond that partner fee" : ""}; the wallet pays the gas on ${from.chain.name}${networkFee.paidIn ? ` in ${networkFee.paidIn}` : ""}, which isn't estimated here.`;

/** The chains a source bridges to; the user picks one, and its pairs come next. */
export function destinationsDecision({ from, destinations }: BridgeDestinations): Decision {
  if (destinations.length === 0) return final(`Nothing on ${from.name} bridges to another chain.`, NONE);
  const listed = destinations.map(({ chain, symbols }) => `${chain.name} (${symbols.join(", ")})`);
  const options = destinations.map(({ chain }) => ({
    label: chain.name,
    args: { fromChain: from.key, toChain: chain.key },
  }));
  return ongoing(
    `From ${from.name}, tokens bridge to ${listed.join("; ")}. Ask the user which chain to bridge to, then call ${TOKENS} with the chosen option's args.`,
    choose("toChain", options, callOnce(TOKENS, "same")),
  );
}

/** What bridges between two chains answers on its own; the user picks a pair to preview or prepare. */
export function pairsDecision({ from, to, pairs }: BridgePairs): Decision {
  if (pairs.length === 0) {
    return final(`Nothing on ${from.name} bridges to ${to.name}: ask the user which other chain to bridge to.`, NONE);
  }
  const labels = pairs.map(pair => `${pair.from.symbol} to ${pair.to.symbol}`);
  const options = pairs.map((pair, i) => {
    const twin = labels.filter(label => label === labels[i]).length > 1;
    const label = twin ? `${labels[i]} (${pair.from.address} to ${pair.to.address})` : labels[i];
    return {
      label: `${label}${tokenChange(pair)}`,
      args: { fromChain: from.key, fromToken: pair.from.address, toChain: to.key, toToken: pair.to.address },
    };
  });
  return ongoing(
    `From ${from.name} to ${to.name}, these bridge: ${options.map(option => option.label).join(", ")}. Ask the user to choose a pair and the amount to send, then call ${PREVIEW} with the chosen option's args and that amount in token units.`,
    choose("pair", options, provide(["amount"], callOnce(PREVIEW, "same"))),
  );
}

/** A preview asks for what preparing needs, then prepares with the same arguments. */
export function previewDecision(preview: BridgePreview): Decision {
  const { from, to, partnerFee, maxAmount, prepareNeeds } = preview;
  const needed = prepareNeeds.map(field => addressAsk(field, from.chain.name, to.chain.name));
  return ongoing(
    [
      `Show the user they would send ${from.amount} ${from.symbol} on ${from.chain.name}${feeText(partnerFee)} and receive ${to.amount} ${to.symbol} on ${to.chain.name}${tokenChange(preview)}; at most ${maxAmount} ${from.symbol} can be bridged on this route now.`,
      costs(preview),
      `Once the user is ready to sign, call ${PREPARE} with the same arguments plus ${needed.join(" and ")}.`,
      walletFirst(from.chain.name),
    ].join(" "),
    provide(prepareNeeds, callOnce(PREPARE, "same")),
  );
}

/** What the wallet's balance, read when preparing, means for sending. */
function balanceText({ balance, warnings, from, networkFee }: BridgeQuote): string {
  if (!balance)
    return `The wallet's balance on ${from.chain.name} couldn't be read; sodax_get_balance with for: bridge reads it.`;
  const short = [
    warnings.includes("balance_short") &&
      `it holds ${balance.token} ${from.symbol} on ${from.chain.name}, less than the ${from.amount} to send, so the bridge would fail`,
    warnings.includes("no_gas") && `it holds no ${networkFee.paidIn ?? "native token"} on ${from.chain.name} for gas`,
  ].filter(Boolean);
  return short.length > 0 ? `Tell the user before they sign: ${short.join(", and ")}.` : "";
}

function prepareNextStep(quote: BridgeQuote): string {
  const { from, to } = quote;
  const sameAddress = sendsToOwnAddressElsewhere(quote)
    ? ` (the sender's own address: make sure they control it on ${to.chain.name})`
    : "";
  const [first] = quote.steps;
  const allowance = approveOf(quote);
  const approve = allowance
    ? ` Tell them the approve lets ${allowance.spender}, the SODAX bridge's spender, spend ${allowance.amount} ${allowance.symbol} of theirs.`
    : "";
  const steps =
    quote.steps.length > 1
      ? "the steps in order, each mined before the next (a bridge sent before its approve is mined fails)"
      : "the bridge step";
  const send =
    "chainType" in first
      ? `Once they confirm, have their ${from.chain.name} wallet send the bridge step: ${SIGN_NON_EVM_TX[first.chainType]}.`
      : `Their wallet must be on ${from.chain.name} (chain id ${first.chainId}); switch it there first if it isn't.${approve} Once they confirm, have their wallet send ${steps}${quote.batch ? SEND_BATCH : ""}.`;
  return [
    `Show the user they send ${from.amount} ${from.symbol} on ${from.chain.name}${feeText(quote.partnerFee)} and receive ${to.amount} ${to.symbol} on ${to.chain.name}${tokenChange(quote)} at ${quote.toAddress}${sameAddress}.`,
    balanceText(quote),
    costs(quote),
    send,
    `Send before ${quote.expiresAt}: there's no on-chain deadline, but a bridge sent later is no longer checked against the route's limit, so prepare again instead.`,
    `Right after the bridge step is broadcast, call ${TRACK} with the bridgeId and its hash, even if expiresAt has passed by then: that call is what submits the bridge.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** A ready bridge is shown to the user, signed in order, and tracked from the moment its last step is broadcast. */
export function prepareDecision(quote: BridgeQuote): Decision {
  const { from, to } = quote;
  const allowance = approveOf(quote);
  const summary: ConfirmSummary = {
    kind: "bridge",
    bridgeId: quote.bridgeId,
    expiresAt: quote.expiresAt,
    send: { amount: from.amount, symbol: from.symbol, chain: from.chain.key },
    receive: { amount: to.amount, symbol: to.symbol, chain: to.chain.key },
    recipient: quote.toAddress,
    partnerFee: quote.partnerFee,
    ...(allowance && { approve: { spender: allowance.spender, amount: allowance.amount, symbol: allowance.symbol } }),
    warnings: quote.warnings,
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

/** What follows a tracked bridge: wait while it moves, stop where it ended, and hand a stuck one to a person. */
export function trackDecision(result: BridgeTrack): Decision {
  const { txHash, chain } = result;
  // The hash asked again keeps the bridge's other arguments; the asks are bounded, then a person.
  const askHash = askTxHash(TRACK, { chain: chain.key, ...(result.bridgeId && { bridgeId: result.bridgeId }) });
  const helpDesk = `give the transaction hash ${txHash} and this result's requestId to the SODAX team`;
  // Polled until the server's clock says the stage took too long (`pollUntil`); then, or once past it, `stalled`.
  const pollOr = (afterSec: number, moving: string, stalled: Decision): Decision => {
    const until = result.pollUntil;
    if (!until) return stalled;
    return ongoing(
      `${moving} Call again in ${afterSec} seconds (each call also waits up to ${trackWait.maxMs / 1000} seconds for the next step) until ${until}; the user must not send the bridge again.`,
      callRepeated(callOnce(TRACK, "same", afterSec), { until }, exhausted(stalled.nextAction, false)),
    );
  };
  const stillMoving = ongoing(
    `The bridge is taking longer than usual: tell the user it's still on its way, that they must not send it again, and that they can track it later with this transaction hash; if it doesn't arrive, ${helpDesk}.`,
    external("still_in_progress"),
  );
  switch (result.status) {
    case "awaiting_source":
      if (result.seenOnChain === false) {
        return pollOr(
          15,
          `${chain.name}'s node doesn't have this transaction yet.`,
          ongoing(
            `${chain.name}'s node still doesn't have this transaction: ask the user for the bridge transaction's hash as their wallet shows it (not the approve's; from a batch, the transaction hash wallet_getCallsStatus reports, not the batch id), then call again with it. Only if the wallet shows it was never sent, or dropped, was nothing bridged: then they can prepare a new bridge. Otherwise they must not send it again.`,
            askHash,
          ),
        );
      }
      return pollOr(
        15,
        `The bridge transaction isn't mined on ${chain.name} yet${result.seenOnChain ? " (its node has it)" : ""}.`,
        ongoing(
          `The bridge transaction still isn't mined on ${chain.name}: ask the user to check it in their wallet, where it may need a higher fee, and then for its hash (a sped-up transaction has a new one). They must not send the bridge again.`,
          external("check_wallet", askHash),
        ),
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
          `That transaction on ${chain.name} isn't this bridge's deposit. Ask the user for the hash of the bridge step their wallet sent (not the approve's), then call again with it. If repeated corrections fail, stop and ${helpDesk}; the user must not send the bridge again.`,
          askHash,
        );
      }
      return final(
        `This server can't submit that bridge (${result.reason.replaceAll("_", " ")}). Tell the user not to send it again, and to ${helpDesk}.`,
        external("help_desk"),
        "unknown",
      );
    case "relaying":
      return pollOr(20, "The bridge is on its way to the SODAX hub.", stillMoving);
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
      return pollOr(20, "The SODAX hub ran the bridge and sent the tokens on to the destination chain.", stillMoving);
    case "delivered":
      if (result.delivery === "sent") {
        return final(
          `The SODAX relay sent the tokens on to the destination chain (its transaction ${result.dstTxHash}), which this server can't follow to the end: tell the user they're on their way, that the destination chain's explorer shows when they arrive, and not to send the bridge again.`,
          NONE,
          "sent",
        );
      }
      return final(
        `The bridge arrived: the recipient has the tokens (destination tx ${result.dstTxHash}).`,
        NONE,
        "succeeded",
      );
    case "held_on_hub":
      return final(
        `The bridge reached the SODAX hub but its calls failed there, so the tokens are in the user's hub wallet on Sonic, not lost. Tell the user not to send it again, and to ${helpDesk}, who can return them.${result.recovery ? ` A developer can also withdraw them to the user's wallet on ${chain.name} with the SODAX SDK's RecoveryService.withdrawHubAsset (recovery's chain, address and token, and at most this bridge's amount, as fetchHubAssetBalances reads it).` : ""}`,
        external("help_desk"),
        "held",
      );
  }
}
