/**
 * Each swap tool result's decision: its `nextAction`, whether it's `terminal`, its `outcome`, and the `nextStep`
 * sentence, from one function per kind of result so the action and the sentence can't disagree.
 *
 * Actions on a result that found the swap carry its arguments in full (`txHash`, `chain` key, `quoteId`); every
 * other action reuses the arguments the runtime sent (`sameArgs`), so nothing here is written back from the caller's
 * own text. Sentences are built from enums, catalog names, checked hashes and the cached quote only.
 */

import { ChainKeys } from "@sodax/types";
import { SODAX_HELP_DESK, SWAP_USD_WARN } from "../constants.js";
import { hashTag } from "../services/requestContext.js";
import { isHubChain } from "../services/sodax.js";
import type { BalanceResult } from "../services/swap/balance.js";
import type { CancelResult } from "../services/swap/cancel.js";
import type { ActionError } from "../services/swap/errors.js";
import { DEFAULT_DEADLINE_MINUTES, type SwapQuote, addressAsk } from "../services/swap/quote.js";
import { type Resolution, resolutionOptions, tokenLabel } from "../services/swap/resolver.js";
import { RETRY_AFTER_SEC } from "../services/swap/source.js";
import { pinnedSourceOf } from "../services/swap/sources/index.js";
import type { EvmStep, NonEvmSourceType } from "../services/swap/sources/types.js";
import { DEPOSIT_SAFE, DEPOSIT_SAFE_UNALERTED, type TrackOutcome, type TrackResult } from "../services/swap/track.js";
import {
  type CallTool,
  type Confirm,
  type ConfirmSummary,
  type Decision,
  type Exhausted,
  NONE,
  type SwapToolName,
  callOnce,
  callRepeated,
  choose,
  exhausted,
  external,
  final,
  ongoing,
  provide,
} from "./nextAction.js";

const TRACK = "sodax_swap_submit_and_track";
const CANCEL = "sodax_swap_cancel";
const PREPARE = "sodax_swap_prepare";

// Retries of a failure that may pass, and of a refund relay, so a stuck one ends with an answer for the user.
const MAX_CALLS = 10;
// Each track call waits for the next step itself, so an agent that can't sleep calls straight back.
// A slow solver can hold a healthy swap for minutes: about 10 minutes of calls before giving up.
const MAX_POLLS = 30;
// A relayed cancel shows on the swap once the hub has run it: about the relay's own two minutes, with room.
const MAX_CANCEL_POLLS = 20;
// What a failure that names no wait is retried after.
const DEFAULT_RETRY_AFTER_SEC = 30;
// Calls a person's answer leads back to, per reason: an agent answering for the user may never stop on its own.
const MAX_ASKS = 3;
// Each cancel costs gas, and a failed or dropped one is replaced: the first and two more for one swap.
const MAX_CANCEL_SENDS = 3;

type Ref = { txHash: string; chain: { key: string }; quoteId?: string };

/** A found swap's arguments for track and cancel, all canonical. */
const swapArgs = ({ txHash, chain, quoteId }: Ref) => ({ txHash, chain: chain.key, ...(quoteId && { quoteId }) });
/** The same without the hash, for a call the user's other hash completes. */
const withoutTxHash = ({ chain, quoteId }: Ref) => ({ chain: chain.key, ...(quoteId && { quoteId }) });
const retryKey = (tool: SwapToolName, ...parts: string[]) => [tool, ...parts].join(":");
/** One workflow's failures, told apart without writing the caller's arguments back. */
const argsDigest = (args: Record<string, unknown>) => hashTag(JSON.stringify(args));

/** A found swap's call, repeated while its result asks again, counted per step of that swap. */
const retrying = (
  tool: SwapToolName,
  swap: Ref,
  step: string[],
  bound: { maxAttempts: number; afterSec: number; args?: Record<string, unknown> },
  onExhausted: Exhausted,
) =>
  callRepeated(
    callOnce(tool, bound.args ?? swapArgs(swap), bound.afterSec),
    { maxAttempts: bound.maxAttempts, retryKey: retryKey(tool, swap.txHash, ...step) },
    onExhausted,
  );

/**
 * A call a person's answer leads to, counted per workflow under a key the answers don't change: a new hash or chain
 * each time still runs out.
 */
const answered = (call: CallTool, reason: string, onExhausted: Exhausted) =>
  callRepeated(call, { maxAttempts: MAX_ASKS, retryKey: retryKey(call.tool, "ask", reason) }, onExhausted);
// Past the bound: before a send nothing is at stake and the workflow ends; after one, whoever can recover it.
const ENDED = exhausted(NONE, true);
const HELP_DESK = exhausted(external("help_desk"), false);

/** A cancel the user agreed to, built at most as often as one is sent. */
const cancelAgain = (args: Record<string, unknown>) =>
  callRepeated(
    callOnce(CANCEL, args),
    { maxAttempts: MAX_CANCEL_SENDS, retryKey: retryKey(CANCEL, "ask", "cancel") },
    HELP_DESK,
  );
/** The user agrees to cancel the swap, and a cancel is built. */
const confirmCancel = (swap: Ref): Confirm => ({
  type: "confirm",
  summary: { kind: "cancel", chain: swap.chain.key, txHash: swap.txHash },
  next: cancelAgain(swapArgs(swap)),
});
/** The swap transaction's hash, asked of the user, for the same call. */
const askTxHash = (tool: typeof TRACK | typeof CANCEL, swap: Ref) =>
  provide(["txHash"], answered(callOnce(tool, withoutTxHash(swap)), "txHash", HELP_DESK));

const giveUp = (what: "swap" | "bridge") =>
  `tell the user this server can't follow the ${what} right now, that they must not send it again, and to give the ${what}'s transaction hash and this result's requestId to ${SODAX_HELP_DESK}.`;

/**
 * Any failure after the user's wallet sent something: one that may pass is the same call again, a few
 * times at most, and none is a reason to send the swap again. Nothing is claimed about the tx: the
 * failure may have come before it was checked.
 */
const afterSendAdvice = (tool: string, sent: string, failure: ActionError, seconds: number, what: "swap" | "bridge") =>
  failure.retryable
    ? `Call ${tool} again in ${seconds} seconds with the same arguments, at most ${MAX_CALLS} times, and don't send the ${sent} again meanwhile. If it still fails, stop: ${giveUp(what)}`
    : `${failure.nextStep} The user must not send the ${what} again.`;

// A swap deposits the token the user sends into its hub vault and withdraws the one they receive.
const RESTRICTED = {
  withdrawOnly: "is withdraw-only: use it only as the token the user receives",
  depositOnly: "is deposit-only: use it only as the token the user sends",
} as const;

/** Which tokens a lookup is for: the swap tools' list, or the bridge tools', which differs. */
export type TokenPurpose = "swap" | "bridge";

// The agent knows which call returned UNKNOWN_TOKEN; a lookup of its own is most often for a quote, or a bridge.
const unknownTokenCall = (purpose: TokenPurpose) =>
  `the call that returned UNKNOWN_TOKEN (${purpose === "bridge" ? "sodax_bridge_prepare" : "sodax_swap_price"} if there was none)`;
const useResolved = (purpose: TokenPurpose) =>
  `Pass chain.key and token.address to ${unknownTokenCall(purpose)}; ${purpose === "bridge" ? "an" : "a quote's"} amount stays in token units.`;

// ── Balance and token lookups ───────────────────────────────────────────

/** Built from catalog symbols, chain names and formatted amounts only. */
function balanceNextStep({ chain, native, token, accountExists, trustline }: BalanceResult): string {
  if (accountExists === false) {
    if (token && token.baseUnits !== "0") {
      return `The wallet has no account on ${chain.name} yet (0 ${native.symbol}) but holds ${token.amount} ${token.symbol}; it needs ${native.symbol} sent to it to pay gas there.`;
    }
    return `The wallet has no account on ${chain.name} yet, so it holds nothing there; it needs ${native.symbol} sent to it first.`;
  }
  const isNative = token?.address === native.address;
  // The SDK reads Stellar's native balance less the minimum reserve and selling liabilities.
  const spendable =
    chain.key === ChainKeys.STELLAR_MAINNET ? " spendable (after the account's reserve and open offers)" : "";
  const held = token && !isNative ? ` and ${token.amount} ${token.symbol}` : "";
  const sentences = [`The wallet's balance on ${chain.name}: ${native.amount} ${native.symbol}${spendable}${held}.`];
  if (token && trustline === false) {
    sentences.push(
      `It has no ${token.symbol} trustline; the wallet must add one before it can receive ${token.symbol}.`,
    );
  }
  if (native.baseUnits === "0") {
    sentences.push(`With no ${native.symbol} it likely can't pay gas there.`);
  } else if (isNative) {
    sentences.push(`Swapping ${native.symbol} also takes ${native.symbol} for gas on top of the amount.`);
  }
  return sentences.join(" ");
}

/** A balance read answers on its own: nothing follows from it. */
export const balanceDecision = (balances: BalanceResult): Decision => final(balanceNextStep(balances), NONE);

/**
 * Built from catalog symbols, addresses and chain names only, never from the caller's
 * query or a token's free-text name.
 */
export function resolveNextStep(resolution: Resolution, purpose: TokenPurpose = "swap"): string {
  const chain = resolution.chain.name;
  const listed = `${purpose} token`;
  switch (resolution.status) {
    case "resolved": {
      const { token } = resolution;
      const named = `${token.symbol} on ${chain}`;
      // The same address can be a different token on each chain.
      const found = resolution.matchedBy === "address" ? `That address is ${named}. ` : "";
      const restricted = token.access ? `${named} ${RESTRICTED[token.access]}. ` : "";
      return `${found}${restricted}${useResolved(purpose)}`;
    }
    case "ambiguous": {
      // Two candidates can share a symbol in any case (bridged and native USDC); the address tells them apart.
      const { candidates } = resolution;
      const labels = candidates.map(token => tokenLabel(token, candidates));
      const ask =
        labels.length === 1
          ? `whether they mean ${labels[0]} on ${chain}`
          : `which of ${labels.join(", ")} on ${chain} they mean`;
      return `Ask the user ${ask}, then pass its address to ${unknownTokenCall(purpose)}.`;
    }
    case "not_found": {
      const [first] = resolution.suggestions;
      const nearest = first && `${first.symbol}${first.isNative ? " (the native token)" : ""}`;
      if (resolution.otherChains) {
        const found = resolution.otherChains.map(other => `${other.token.symbol} on ${other.chain.name}`).join(", ");
        // A symbol listed elsewhere may still be a near miss here: WETH on Arbitrum is most likely its ETH.
        if (nearest) {
          return `No ${listed} on ${chain} matches that; it is listed as ${found}, and the nearest on ${chain} is ${nearest}. Ask the user which they mean, then call sodax_resolve_token again with that chain.`;
        }
        return `No ${listed} on ${chain} matches that; it is ${found}. Confirm the chain with the user, then call sodax_resolve_token again with the chain the user confirms.`;
      }
      if (!nearest) return `No ${listed} matches on ${chain}; confirm the chain and token with the user.`;
      return `No ${listed} matches on ${chain}; ask the user whether they mean ${nearest} or another suggestion.`;
    }
  }
}

export function resolveDecision(resolution: Resolution, purpose: TokenPurpose = "swap"): Decision {
  const nextStep = resolveNextStep(resolution, purpose);
  if (resolution.status === "resolved") return final(nextStep, NONE);
  // A pick is looked up again and resolves; a value the user names may not, so that loop is bounded.
  const again = answered(callOnce("sodax_resolve_token", "same"), resolution.status, ENDED);
  const options = resolutionOptions(resolution, { token: "query", chain: "chain" });
  if (options.length === 0) return ongoing(nextStep, provide(["chain", "query"], again));
  return ongoing(nextStep, choose("query", options, again));
}

// ── Quotes ──────────────────────────────────────────────────────────────

const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

type QuoteWarning = Extract<ConfirmSummary, { kind: "swap" }>["warnings"][number];

/**
 * What the quote's USD values couldn't settle. Warns, never refuses: an agent passing base units as token units
 * shows up as a huge value, and an output with no price skips the off-market check.
 */
function usdChecks({ usdValue, usdOut }: SwapQuote): QuoteWarning[] {
  if (usdValue === null) return ["usd_unchecked"];
  return [
    ...(Number(usdValue) > SWAP_USD_WARN ? (["above_warn_level"] as const) : []),
    ...(usdOut === null ? (["rate_unchecked"] as const) : []),
  ];
}

/** `usdChecks` as the sentences a quote's nextStep carries. */
function usdWarning(quote: SwapQuote): string {
  const checks = usdChecks(quote);
  if (checks.includes("usd_unchecked")) {
    return " Its USD value couldn't be checked, so confirm a large amount with the user before anything is signed.";
  }
  const unpriced = checks.includes("rate_unchecked")
    ? " What they receive has no USD price here, so the rate wasn't checked against the market: confirm the amounts with the user before anything is signed."
    : "";
  if (!checks.includes("above_warn_level")) return unpriced;
  return ` This swap is worth about ${usd(Number(quote.usdValue))}, above this server's warning level of ${usd(SWAP_USD_WARN)}: confirm the amount with the user before anything is signed.${unpriced}`;
}

// A smart-contract wallet may not exist, or have the same owner, at its address on another chain.
export const sendsToOwnAddressElsewhere = ({
  from,
  to,
  toAddress,
  fromAddress,
}: { from: { chain: { key: string } }; to: { chain: { key: string } }; toAddress: string; fromAddress: string }) =>
  from.chain.key !== to.chain.key && toAddress.toLowerCase() === fromAddress.toLowerCase();

function quoteNextStep(quote: SwapQuote): string {
  const { from, to, partnerFee } = quote;
  const fee = partnerFee ? `, including a ${partnerFee.amount} ${partnerFee.symbol} partner fee,` : "";
  const sendAndReceive = `${from.amount} ${from.symbol} on ${from.chain.name}${fee} and receive about ${to.expectedAmount} ${to.symbol} on ${to.chain.name}`;
  const warning = usdWarning(quote);
  if (quote.status === "price") {
    const needed = quote.prepareNeeds.map(field => addressAsk(field, from.chain.name, to.chain.name));
    return `Show the user they would send ${sendAndReceive}.${warning} Once the user is ready to sign, call sodax_swap_prepare with the same arguments plus ${needed.join(" and ")}.`;
  }
  const show = `Show the user they send ${sendAndReceive} (at least ${quote.to.minimumAmount})`;
  const sameAddress = sendsToOwnAddressElsewhere(quote)
    ? ` (the sender's own address: make sure they control it on ${to.chain.name})`
    : "";
  const batch = quote.batch ? SEND_BATCH : "";
  const [first] = quote.steps;
  const allowance = approveOf(quote);
  const approve = allowance
    ? ` Tell them the approve lets ${allowance.spender}, the SODAX swap contract, spend ${allowance.amount} ${allowance.symbol} of theirs.`
    : "";
  const send =
    "chainType" in first
      ? `Once they confirm, have their ${from.chain.name} wallet send the swap step before it expires: ${SIGN_NON_EVM_TX[first.chainType]}.`
      : `Their wallet must be on ${from.chain.name} (chain id ${first.chainId}) to send the steps; switch it there first if it isn't.${approve} Once they confirm, have their wallet send the steps in order before it expires, each mined before the next (a swap sent before its approve is mined fails)${batch}.`;
  return [
    `${show} at ${quote.toAddress}${sameAddress}; the quote expires at ${quote.expiresAt}.${warning}`,
    "Balances aren't checked here; sodax_get_balance reads them.",
    send,
    `Then call sodax_swap_submit_and_track with the quoteId and the swap transaction's hash, even if the quote has expired by then: that call is what submits the swap${isHubChain(from.chain.key) ? "" : ", or starts its refund"}.`,
  ].join(" ");
}

/** How a wallet that batches sends a result's `batch` in place of the steps it replaces. */
export const SEND_BATCH =
  " (or, if the wallet batches, wallet_sendCalls with the batch's params plus calls: the {to, value, data} of each step it replaces, in order, once any step it doesn't replace is mined)";

/** What the approve step, if any, lets its spender take. */
export const approveOf = ({ steps }: { steps: readonly { kind: string }[] }) =>
  steps.find((step): step is EvmStep => step.kind === "approve")?.approves;

// How a family's wallet sends the SDK's raw tx (`steps[].tx`; bigints are decimal strings, bytes base64).
export const SIGN_NON_EVM_TX: Record<NonEvmSourceType, string> = {
  NEAR: "one transaction from signerId to params.contractId calling params.method with params.args, attaching params.deposit (yoctoNEAR) and params.gas",
  SOLANA:
    "data is an unsigned v0 transaction (base64) with the user as fee payer, which the wallet signs and sends at once: its blockhash expires in about a minute, and if it expires unsent, call this tool again with the same arguments for a new one",
  STELLAR:
    "data is the transaction envelope (XDR, public network), which the wallet signs and submits; any other transaction from the account first makes it unusable",
  SUI: "data is the transaction as JSON (Transaction.from), with its sender set, which that account's wallet signs and executes",
  INJECTIVE:
    "the wallet signs signedDoc in direct mode (bodyBytes and authInfoBytes in base64) and broadcasts it, or an EIP-712 wallet sends the same contract execution from that account; any other transaction from the account first makes the signed one unusable",
};

/**
 * A price asks for what preparing needs; a ready quote is shown to the user, signed in order, and tracked from the
 * moment its last step is broadcast. Track gets the chain too, so a quote this server lost still has its deposit
 * checked.
 */
export function quoteDecision(quote: SwapQuote): Decision {
  const nextStep = quoteNextStep(quote);
  if (quote.status === "price") return ongoing(nextStep, provide(quote.prepareNeeds, callOnce(PREPARE, "same")));
  const { from, to, partnerFee } = quote;
  const allowance = approveOf(quote);
  const summary: ConfirmSummary = {
    kind: "swap",
    quoteId: quote.quoteId,
    expiresAt: quote.expiresAt,
    send: { amount: from.amount, symbol: from.symbol, chain: from.chain.key },
    receiveAtLeast: { amount: to.minimumAmount, symbol: to.symbol, chain: to.chain.key },
    expected: { amount: to.expectedAmount, symbol: to.symbol },
    recipient: quote.toAddress,
    ...(partnerFee && { partnerFee: { amount: partnerFee.amount, symbol: partnerFee.symbol } }),
    usdValue: quote.usdValue,
    usdOut: quote.usdOut,
    ...(allowance && { approve: { spender: allowance.spender, amount: allowance.amount, symbol: allowance.symbol } }),
    warnings: [
      ...usdChecks(quote),
      ...(sendsToOwnAddressElsewhere(quote) ? (["own_address_other_chain"] as const) : []),
    ],
  };
  const afterSend = {
    ...callOnce(TRACK, { quoteId: quote.quoteId, chain: from.chain.key }),
    on: "broadcast" as const,
    needs: ["txHash"] as ["txHash"],
  };
  return ongoing(nextStep, {
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

// ── Tracking ────────────────────────────────────────────────────────────

// A swap from the hub is an intent there already: it's filled or, once expired, refunded without an operator.
const safe = ({ alerted, chain }: { alerted: boolean; chain: { key: string; name: string } }) =>
  isHubChain(chain.key)
    ? `tell the user the swap is on ${chain.name} and safe: unless a solver fills it first, it's refunded to them once its quote expires, and they must not send it again`
    : alerted
      ? DEPOSIT_SAFE
      : DEPOSIT_SAFE_UNALERTED;
const isNonEvmChain = (chainKey: string) => {
  const family = pinnedSourceOf(chainKey)?.adapter.family;
  return family !== undefined && family !== "EVM";
};
/**
 * A tx its node can't confirm. Only EVM, Solana and NEAR nodes can say they don't have one; the others can't tell one
 * in flight from one never sent. A batch id is EVM's.
 */
const unseen = ({ key, name }: { key: string; name: string }) => {
  if (!isNonEvmChain(key)) {
    return `${name} hasn't seen this transaction. Check that the user's wallet really broadcast it and that this is its transaction hash, not a batch id`;
  }
  const check = "Check that the user's wallet really sent it and that this is its transaction hash";
  return pinnedSourceOf(key)?.adapter.seen
    ? `${name} hasn't seen this transaction. ${check}`
    : `${name} hasn't confirmed this transaction yet. ${check}`;
};
// The hub deletes an intent once filled or cancelled, so its state alone can't tell which.
const INTENT_CLOSED =
  "The swap's intent is no longer open on the hub: a solver filled it, or it was cancelled or refunded to the user. sodax_get_balance on the recipient and on the user's source address shows which; either way, the user must not send it again.";
const again = (seconds: number) => `call sodax_swap_submit_and_track again in about ${seconds} seconds`;
const POLL = `call sodax_swap_submit_and_track again (it waits up to 20 seconds for the next step), at most ${MAX_POLLS} times at this step. If it's still at this step after that, stop: tell the user the swap is still in progress, that they must not send it again, and that they can track it later with this transaction hash.`;

/**
 * A deposit that waits for an operator: paged already, or the user writes to the help desk. A swap from the hub is
 * an intent there already, filled or refunded without anyone: its outcome is unknown, and nobody needs to act.
 */
const heldIfDeclined = (alerted: boolean, chain: { key: string }): Exhausted =>
  isHubChain(chain.key)
    ? exhausted(NONE, true, "unknown")
    : exhausted(alerted ? NONE : external("help_desk"), true, "held");
const held = (nextStep: string, alerted: boolean, chain: { key: string }): Decision => ({
  nextStep,
  ...heldIfDeclined(alerted, chain),
});

/** Track again while the swap stays at this step, counted per step; past the count, a person decides when. */
const poll = (result: TrackResult & { retryAfterSec?: number }, ...step: string[]) =>
  retrying(
    TRACK,
    result,
    [result.status, ...step],
    { maxAttempts: MAX_POLLS, afterSec: result.retryAfterSec ?? RETRY_AFTER_SEC },
    exhausted(external("still_in_progress"), false),
  );

/** A refund relay that failed: retried a few times, then whoever must recover it does. */
const refundDecision = (
  tool: typeof TRACK | typeof CANCEL,
  result: Ref & { alerted: boolean; retryAfterSec: number; chain: { key: string; name: string } },
): Decision =>
  ongoing(
    `The swap won't be filled and its refund couldn't start: ${safe(result)}. To retry the refund, call ${tool} again in about ${result.retryAfterSec} seconds, at most ${MAX_CALLS} times, then stop.`,
    retrying(
      tool,
      result,
      ["expired_unsubmitted"],
      { maxAttempts: MAX_CALLS, afterSec: result.retryAfterSec },
      heldIfDeclined(result.alerted, result.chain),
    ),
  );

function notSubmittedDecision(result: Extract<TrackResult, { status: "not_submitted" }>): Decision {
  if (result.reason === "not_a_deposit") {
    return ongoing(
      "That transaction isn't this quote's swap (on an EVM chain it may be the approve, or a swap call that failed inside a batch); ask for the swap transaction's hash.",
      askTxHash(TRACK, result),
    );
  }
  const deposit = safe(result);
  switch (result.reason) {
    case "deposit_mismatch": {
      const declined = heldIfDeclined(result.alerted, result.chain);
      return ongoing(
        `That transaction is a SODAX deposit for another quote: track it with the quoteId it was made from. Without that quoteId, ${deposit}.`,
        provide(
          ["quoteId"],
          answered(callOnce(TRACK, { txHash: result.txHash, chain: result.chain.key }), "quoteId", declined),
          declined,
        ),
      );
    }
    case "other_sender":
      return held(
        `That transaction sent this quote's swap from another address than its fromAddress, so this server can't submit it: ${deposit}.`,
        result.alerted,
        result.chain,
      );
    case "quote_used":
      return held(
        `This quote was already used by another transaction, so this one can't become a swap: ${deposit}.`,
        result.alerted,
        result.chain,
      );
    case "unverified":
      // Nothing proves the funds are held: the events that would show it couldn't be read.
      return final(
        `This server can't read all of that transaction's events, so it can't tell whether it holds this swap, and won't submit it. If it is this swap's deposit, ${deposit}. If it isn't, ask for the swap transaction's hash.`,
        external("help_desk"),
        "unknown",
      );
    case "multiple_deposits":
      return held(
        `That transaction carries other SODAX messages besides this swap (another deposit or a cancel), so this server can't submit it: ${deposit}. Next time, send each swap as its own transaction.`,
        result.alerted,
        result.chain,
      );
  }
}

const OUTCOME: Record<TrackOutcome, string> = {
  cancelled: "The swap was cancelled; its funds go back to the user.",
  refunding: "The swap couldn't be filled and is being refunded to the user.",
  abandoned: "The swap couldn't be processed.",
  cancel_to_recover: "The swap wasn't filled.",
  unknown: "The swap failed.",
};

function failedNextStep({ canCancel, failure }: Extract<TrackResult, { status: "failed" }>): string {
  if (canCancel) {
    return "The user can cancel it with sodax_swap_cancel to get the funds back. If they already sent a cancel, don't send another: follow the one sent.";
  }
  if (failure === "cancelled" || failure === "refunding") return "There's nothing to do here.";
  return "The deposit is safe on chain and SODAX operators will recover it; the user must not send it again.";
}

export function trackDecision(result: TrackResult): Decision {
  const chain = result.chain.name;
  const args = swapArgs(result);
  const askHash = askTxHash(TRACK, result);
  switch (result.status) {
    case "awaiting_source_confirmation": {
      if (result.seenOnChain) {
        return ongoing(
          `The swap transaction isn't confirmed on ${chain} yet; don't resend it, and ${POLL}`,
          poll(result, "seen"),
        );
      }
      const head = `${unseen(result.chain)}; if it was never sent, stop tracking it. Otherwise don't resend it, and `;
      if (result.pollUntil) {
        // Past pollUntil, one more call gets the answer that asks the user instead.
        return ongoing(
          `${head}call sodax_swap_submit_and_track again in about ${result.retryAfterSec} seconds until ${result.pollUntil}, then follow that answer.`,
          callRepeated(
            callOnce(TRACK, args, result.retryAfterSec),
            { until: result.pollUntil },
            exhausted(callOnce(TRACK, args), false),
          ),
        );
      }
      if (result.stopAfter) {
        return ongoing(
          `${head}stop calling on a timer: ask the user to check their wallet, and call sodax_swap_submit_and_track again once it shows the swap sent, or once after ${result.stopAfter} and follow that answer.`,
          // Tracked soon once the user says it was sent: waiting for stopAfter would pass the deadline. Bounded, so a
          // runtime that keeps saying yes while the node still hasn't seen it stops.
          external(
            "check_wallet",
            retrying(
              TRACK,
              result,
              ["said_sent"],
              { maxAttempts: 3, afterSec: RETRY_AFTER_SEC },
              exhausted(external("still_in_progress"), false),
            ),
          ),
        );
      }
      return ongoing(`${head}${POLL}`, poll(result, "unseen"));
    }
    case "source_not_found": {
      // A sped-up or replaced tx has a new hash; its deposit still matches the quote.
      const quoteId = result.quoteId ? "the same quoteId" : "its quoteId";
      // Public non-EVM nodes keep recent txs only, so an older swap reads as unknown too.
      if (isNonEvmChain(result.chain.key)) {
        return ongoing(
          `${chain}'s node doesn't have this transaction: it may be too new, older than the node keeps, or not a transaction on ${chain}. If it was sent less than a minute ago, call sodax_swap_submit_and_track again in about ${RETRY_AFTER_SEC} seconds first. Check that this is the swap transaction's hash on ${chain}. If the wallet shows it was sent, this server can't follow it: the user must not send it again, and can check it in a ${chain} explorer. Only if the wallet shows it was never sent: nothing was swapped, so stop tracking it and call sodax_swap_prepare again if the user still wants to swap.`,
          retrying(
            TRACK,
            result,
            ["source_not_found"],
            { maxAttempts: 1, afterSec: RETRY_AFTER_SEC },
            exhausted(external("check_wallet", askHash), false),
          ),
        );
      }
      return ongoing(
        `${chain} hasn't seen this transaction. Check that this is the swap transaction's hash on ${chain}, not a batch id. If the user's wallet sped it up or replaced it, call sodax_swap_submit_and_track with the new transaction's hash and ${quoteId}. Only if the wallet shows it was never sent: nothing was swapped, so stop tracking it and call sodax_swap_prepare again if the user still wants to swap.`,
        askHash,
      );
    }
    case "source_failed":
      if ("depositHeld" in result && result.notThisQuote) {
        const recover = result.alerted
          ? "SODAX operators were alerted to recover it"
          : `whoever sent it can give its hash to ${SODAX_HELP_DESK} to recover it`;
        return ongoing(
          `That transaction failed on ${chain} after a SODAX deposit went through, but not this quote's swap: ${recover}. Ask the user for this swap's transaction hash and track that; if this one is theirs too, they must not send it again.`,
          askHash,
        );
      }
      if ("depositHeld" in result) {
        return held(
          `The swap transaction failed on ${chain} after its deposit went through, so it can't be swapped: ${safe(result)}.`,
          result.alerted,
          result.chain,
        );
      }
      return final(
        `The swap transaction failed on ${chain}: nothing was swapped, only gas was spent. Call sodax_swap_prepare again if the user wants to retry.`,
        NONE,
        "failed",
      );
    case "not_submitted":
      return notSubmittedDecision(result);
    case "not_submitted_unknown_quote":
      // Only a deposit named by its quoteId alerts.
      if (result.isDeposit && result.quoteId) {
        return held(`This server has no quote for that deposit: ${safe(result)}.`, result.alerted, result.chain);
      }
      return result.isDeposit
        ? ongoing(
            "This server has no record of that SODAX deposit. If it came from sodax_swap_prepare, call sodax_swap_submit_and_track again with the same arguments plus its quoteId; otherwise track it where it was made. Either way, the user must not send it again.",
            provide(
              ["quoteId"],
              answered(callOnce(TRACK, { txHash: result.txHash, chain: result.chain.key }), "quoteId", HELP_DESK),
            ),
          )
        : ongoing(
            `That transaction isn't a SODAX swap deposit on ${chain}; ask for the swap transaction's hash.`,
            askHash,
          );
    case "expired_refunding":
      return final(
        "The swap won't be filled: its deposit is being refunded to the user, and they must not send it again.",
        NONE,
        "refunding",
      );
    case "expired_awaiting_refund":
      // Refunded without anyone acting, or sooner by a cancel: the user decides, so it isn't over.
      return ongoing(
        `The swap expired before it was submitted: unless a solver filled it first, SODAX refunds its intent on ${chain} to the user, and they must not send it again. To get it back sooner, the user can cancel it now with sodax_swap_cancel.`,
        confirmCancel(result),
      );
    case "intent_closed":
      return final(INTENT_CLOSED, NONE, "unknown");
    case "expired_unsubmitted":
      return refundDecision(TRACK, result);
    case "submit_refused":
      // Due after the deadline, when the call starts the refund: one call, never a bounded repeat.
      return ongoing(
        isHubChain(result.chain.key)
          ? `The swap service refused this swap: ${safe(result)}. Then ${again(result.retryAfterSec)}.`
          : `The swap service refused this deposit, so it won't be swapped: ${safe(result)}. Once the quote expires this server starts the refund: ${again(result.retryAfterSec)}.`,
        callOnce(TRACK, args, result.retryAfterSec),
      );
    case "queued":
      return ongoing(`The swap is queued for processing; ${POLL}`, poll(result));
    case "in_progress":
      return ongoing(`The swap is being processed (${result.stage}); ${POLL}`, poll(result, result.stage));
    case "solved": {
      // Solved is the fill on the hub; another destination gets the tokens one cross-chain hop later.
      const fill = result.fillTxHash ? ` (fill tx ${result.fillTxHash})` : "";
      const promised = result.minimumReceived;
      if (promised && result.delivery === "complete") {
        return final(
          `The swap is complete on ${promised.chainName}: the user received at least ${promised.amount} ${promised.symbol}${fill}.`,
          NONE,
          "succeeded",
        );
      }
      // Done only once the tokens arrive: track follows that last hop.
      const onItsWay = promised
        ? `The swap is filled${fill}: at least ${promised.amount} ${promised.symbol} is on its way to ${promised.chainName}, arriving after one more cross-chain hop.`
        : `The swap is filled on the SODAX hub${fill}; to a chain other than Sonic the tokens arrive after one more cross-chain hop.`;
      return ongoing(`${onItsWay} Don't send it again; ${POLL}`, poll(result, "delivery"));
    }
    case "failed": {
      const nextStep = `${OUTCOME[result.failure]} ${failedNextStep(result)}`;
      if (result.canCancel) return ongoing(nextStep, confirmCancel(result));
      if (result.failure === "cancelled" || result.failure === "refunding") {
        return final(nextStep, NONE, result.failure);
      }
      return final(nextStep, NONE, "held");
    }
    case "unknown":
      return final(
        "The swap service reports a status this server doesn't know, so it can't tell how the swap ended: stop tracking it, and tell the user its outcome isn't known here yet and that they must not send it again.",
        NONE,
        "unknown",
      );
  }
}

// ── Cancelling ──────────────────────────────────────────────────────────

const NOT_CANCELLABLE: Record<Extract<CancelResult, { status: "not_cancellable" }>["reason"], string> = {
  not_submitted: `The swap service has no record of this swap yet, so there's nothing to cancel yet: call sodax_swap_cancel again with the same arguments in about ${RETRY_AFTER_SEC} seconds, at most ${MAX_CALLS} times. If it still has none, stop: tell the user the swap can't be cancelled here yet, that they must not send it again, and to give its transaction hash to ${SODAX_HELP_DESK}. Don't call sodax_swap_submit_and_track for it: that would submit the swap.`,
  solved:
    "The swap was filled before it could be cancelled, so there's nothing to cancel: call sodax_swap_submit_and_track with the swap's txHash to follow it until it arrives.",
  cancelled: "The swap is already cancelled.",
  refunding: "The swap is already being refunded to the user.",
  not_on_hub_yet: `The swap service hasn't put this swap on the hub yet, so it can't be cancelled yet: call sodax_swap_cancel again with the same arguments in about ${RETRY_AFTER_SEC} seconds, at most ${MAX_CALLS} times.`,
  not_sent:
    "The swap transaction isn't confirmed, or it failed, so nothing was sent and there's nothing to cancel yet. If it's still pending, call sodax_swap_cancel again once it's confirmed; on an EVM chain the user can also cancel or replace it in their wallet.",
  closed: `There's nothing to cancel. ${INTENT_CLOSED}`,
  not_this_swap:
    "That transaction didn't create this quote's swap: ask for the swap transaction's hash (not an approval's) and call sodax_swap_cancel again with it.",
  unverified: `This server can't read all of the swap transaction's events, so without its quote it can't tie the swap to it: it won't build a cancel, or relay one already sent. Tell the user the swap is safe on the SODAX hub, and to give its transaction hash, and the cancel's if they sent one, to ${SODAX_HELP_DESK}.`,
};

function notCancellableDecision(result: Extract<CancelResult, { status: "not_cancellable" }>): Decision {
  const args = swapArgs(result);
  const nextStep = NOT_CANCELLABLE[result.reason];
  // A cancel already sent is read again, never left behind: dropping its hash would build a second one.
  const retryArgs = result.cancelTxHash ? { ...args, cancelTxHash: result.cancelTxHash } : args;
  const retryCancel = (onExhausted: Exhausted) =>
    retrying(
      CANCEL,
      result,
      [result.reason],
      { maxAttempts: MAX_CALLS, afterSec: RETRY_AFTER_SEC, args: retryArgs },
      onExhausted,
    );
  switch (result.reason) {
    case "not_submitted":
      // A tx on the hub that created an intent needs no record to be refunded: the backend's canceller reads the chain.
      if (isHubChain(result.chain.key)) {
        return final(
          `The swap service has no record of this swap, so it can't be cancelled here. If that transaction created a swap on ${result.chain.name}, its intent is there already: unless a solver fills it first, it's refunded to the user once it expires, and they must not send it again.`,
          NONE,
          "unknown",
        );
      }
      // Never track: with its quote, track submits a deposit it can read, the opposite of a cancel.
      return ongoing(nextStep, retryCancel(exhausted(external("help_desk"), false)));
    case "solved":
      // Track is what confirms the tokens arrived.
      return ongoing(nextStep, callOnce(TRACK, args));
    case "cancelled":
      return final(nextStep, NONE, "cancelled");
    case "refunding":
      return final(nextStep, NONE, "refunding");
    case "closed":
      return final(nextStep, NONE, "unknown");
    case "not_on_hub_yet":
      // Still a cancel: once the swap reaches the hub, the next call builds it.
      return ongoing(nextStep, retryCancel(exhausted(external("still_in_progress"), false)));
    case "not_sent":
      return ongoing(nextStep, retryCancel(exhausted(external("check_wallet"), false)));
    case "not_this_swap":
      return ongoing(nextStep, askTxHash(CANCEL, result));
    case "unverified":
      return final(nextStep, external("help_desk"), "unknown");
  }
}

/** Built from enums and catalog names only. */
export function cancelDecision(result: CancelResult): Decision {
  const chain = result.chain.name;
  const args = swapArgs(result);
  switch (result.status) {
    case "not_cancellable":
      return notCancellableDecision(result);
    case "deposit_unsubmitted":
      // Due after the deadline, when the call starts the refund.
      return ongoing(
        `The swap's deposit is on ${chain} but was never submitted, so it won't be swapped unless sodax_swap_submit_and_track is called: don't call it. To get the funds back, call sodax_swap_cancel again with the same arguments in about ${result.retryAfterSec} seconds, once the quote has expired, and this server starts the refund. The deposit is safe meanwhile; the user must not send it again.`,
        callOnce(CANCEL, args, result.retryAfterSec),
      );
    case "expired_unsubmitted":
      return refundDecision(CANCEL, result);
    case "ready": {
      const [step] = result.steps;
      const how = "chainType" in step ? ` (${SIGN_NON_EVM_TX[step.chainType]})` : "";
      return ongoing(
        `Have the user's wallet send the cancel step on ${chain}${how}, then call sodax_swap_cancel again with the same arguments plus cancelTxHash.`,
        {
          type: "execute",
          chain: result.chain.key,
          stepsAt: "steps",
          waitFor: "receipt_success",
          // Counted before the wallet signs: whatever path leads back here, a swap gets so many cancels.
          afterSend: {
            ...callRepeated(
              callOnce(CANCEL, args),
              { maxAttempts: MAX_CANCEL_SENDS, retryKey: retryKey(CANCEL, "send") },
              HELP_DESK,
            ),
            on: "broadcast",
            needs: ["cancelTxHash"],
          },
        },
      );
    }
    case "cancel_awaiting_confirmation":
      return ongoing(
        `The cancel isn't confirmed on ${chain} yet; call sodax_swap_cancel again in about ${result.retryAfterSec} seconds, and don't resend it. Only if the wallet shows it was never sent (a Solana one expires in about a minute), call sodax_swap_cancel without cancelTxHash for a new one.`,
        retrying(
          CANCEL,
          result,
          ["cancel_awaiting_confirmation", result.cancelTxHash],
          {
            maxAttempts: MAX_CALLS,
            afterSec: result.retryAfterSec,
            args: { ...args, cancelTxHash: result.cancelTxHash },
          },
          // A new cancel only once the wallet shows this one can never land: someone's yes isn't enough.
          exhausted(
            {
              type: "confirm",
              summary: {
                kind: "unsent_cancel",
                chain: result.chain.key,
                txHash: result.txHash,
                cancelTxHash: result.cancelTxHash,
              },
              by: "wallet",
              next: cancelAgain(args),
            },
            false,
          ),
        ),
      );
    case "cancel_failed":
      // Another cancel costs gas again: the user decides, never a loop of signatures.
      return ongoing(
        `The cancel transaction failed on ${chain}; only gas was spent. If the user still wants to cancel, call sodax_swap_cancel without cancelTxHash for a new one; after ${MAX_CANCEL_SENDS} cancels for one swap, stop and send the user to ${SODAX_HELP_DESK} instead.`,
        confirmCancel(result),
      );
    case "not_a_cancel_tx":
      return ongoing(
        "That transaction isn't the cancel for this swap; ask for the cancel transaction's hash.",
        provide(["cancelTxHash"], answered(callOnce(CANCEL, args), "cancelTxHash", HELP_DESK)),
      );
    case "cancel_relayed": {
      // The backend may report the swap cancellable until the hub has run this cancel: track, never cancel again.
      const follow = retrying(
        TRACK,
        result,
        ["cancel", result.cancelTxHash],
        { maxAttempts: MAX_CANCEL_POLLS, afterSec: result.unverified ? 180 : RETRY_AFTER_SEC },
        exhausted(external("help_desk"), false),
      );
      if (result.unverified) {
        return ongoing(
          `This server can't read all of that ${chain} transaction's events, so it couldn't confirm it's this swap's cancel; it was passed to the SODAX relay, which checks it. Call sodax_swap_submit_and_track (it won't submit the swap again) in a few minutes: if the swap isn't reported cancelled, check with the user that this hash is the cancel their wallet sent, and if it isn't, call sodax_swap_cancel again with the right one.`,
          follow,
        );
      }
      return ongoing(
        "The cancel is on its way to the hub; call sodax_swap_submit_and_track (it won't submit the swap again) to see it reported as cancelled.",
        follow,
      );
    }
    case "cancel_confirmed":
      // Confirmed by the hub's own log: a backend row may still say it can be cancelled, so track isn't asked.
      return final(
        "The swap is cancelled on the hub and the funds are on their way back to the user; there's nothing more to do, and they must not send it again.",
        NONE,
        "cancelled",
      );
  }
}

// ── Failures ────────────────────────────────────────────────────────────

/** Which call failed, and the arguments it took. */
export interface FailureContext {
  tool: SwapToolName;
  args: Record<string, unknown>;
}

/** Track and cancel are called once the user's wallet sent something. */
const AFTER_SEND: readonly SwapToolName[] = [TRACK, CANCEL, "sodax_bridge_submit_and_track"];

export function errorDecision(failure: ActionError, { tool, args }: FailureContext): Decision {
  const sent = AFTER_SEND.includes(tool);
  const seconds = Number(failure.details?.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC);
  const what = tool.startsWith("sodax_bridge_") ? "bridge" : "swap";
  const advice = sent
    ? afterSendAdvice(tool, tool === CANCEL ? "cancel" : what, failure, seconds, what)
    : failure.nextStep;
  // The field the throw site named, which the user is asked again; a failure that names none is handed off.
  const named = failure.details?.field;
  const field = typeof named === "string" ? named : undefined;
  const same = (overrides?: Record<string, unknown>) => ({
    ...callOnce(tool, "same"),
    ...(overrides && { args: overrides }),
  });
  // The same call once a person has answered, counted per code: an agent answering for them still stops.
  const answer = (overrides?: Record<string, unknown>) =>
    answered(same(overrides), failure.code, sent ? HELP_DESK : ENDED);
  // After a send, a failure nothing here can fix keeps the hash and goes to whoever can recover it.
  const stuck = () => ongoing(advice, external(sent ? "help_desk" : "service_unavailable"));
  const askFor = (fields: string[]) => ongoing(advice, provide(fields, answer()));
  const pick = () => (field ? ongoing(advice, choose(field, failure.hint?.options ?? [], answer())) : stuck());
  // This call's own failures, whatever their codes: a flaky upstream alternating 503 and 429 still runs out.
  const key = retryKey(tool, argsDigest(args));
  switch (failure.code) {
    case "INTERNAL":
    case "RATE_LIMITED":
    case "CHAIN_UNAVAILABLE":
    case "UPSTREAM_UNAVAILABLE":
      // The same call again, counted while it keeps failing in a row.
      if (!failure.retryable) return stuck();
      return ongoing(
        advice,
        callRepeated(
          callOnce(tool, "same", seconds),
          { maxAttempts: MAX_CALLS, retryKey: key, consecutive: true },
          sent ? exhausted(external("help_desk"), true, "unknown") : exhausted(external("service_unavailable"), false),
        ),
      );
    case "UNKNOWN_TOKEN":
      // A token this server can't read for the wallet: nothing the user picks changes that.
      if (failure.details?.reason === "unreadable") return final(advice, NONE);
      return pick();
    case "UNSUPPORTED_CHAIN":
    case "UNSUPPORTED_SOURCE":
    case "RESTRICTED_TOKEN":
      return pick();
    case "INVALID_TX_HASH": {
      const format = failure.details?.format;
      return field
        ? ongoing(advice, provide([{ name: field, ...(typeof format === "string" && { format }) }], answer()))
        : stuck();
    }
    case "INVALID_ADDRESS": {
      const missing = failure.details?.missing;
      if (Array.isArray(missing)) return askFor(missing.map(String));
      return field ? askFor([field]) : stuck();
    }
    case "INVALID_AMOUNT":
    case "QUOTE_MISMATCH":
    case "QUOTE_NOT_FOUND":
    case "PRICE_OFF_MARKET":
      return field ? askFor([field]) : stuck();
    case "AMOUNT_TOO_LOW": {
      const { suggestedAmount, symbol } = failure.details ?? {};
      if (typeof suggestedAmount === "string" && typeof symbol === "string") {
        return ongoing(advice, {
          type: "confirm",
          summary: { kind: "amount", amount: suggestedAmount, symbol },
          next: answer({ amount: suggestedAmount }),
        });
      }
      return ongoing(advice, provide(["amount"], answer()));
    }
    case "DEADLINE_TOO_SHORT": {
      const minutes = Number(args.deadlineMinutes);
      // Retried once, at the default: a longer deadline than that means the builds are slow, not the deadline short.
      if (tool === PREPARE && minutes < DEFAULT_DEADLINE_MINUTES) {
        return ongoing(
          advice,
          callRepeated(
            same({ deadlineMinutes: DEFAULT_DEADLINE_MINUTES }),
            { maxAttempts: 1, retryKey: `${key}:deadline` },
            exhausted(external("service_unavailable"), false),
          ),
        );
      }
      if (sent) return stuck();
      return ongoing(
        "Preparing the swap took too long to leave time to send it: tell the user the swap service is slow right now and to try again later.",
        external("service_unavailable"),
      );
    }
    case "SWAP_REJECTED":
    case "BRIDGE_REJECTED":
      switch (failure.details?.reason) {
        case "no_route":
        case "no_liquidity":
        case "amount_too_large":
          // Track and cancel take no amount: after a send there's nothing to ask for.
          return sent ? stuck() : ongoing(advice, provide(["amount", { name: "toToken", optional: true }], answer()));
        case "not_bridgeable":
          return pick();
        case "same_chain":
        case "above_limit":
          return field && !sent ? askFor([field]) : stuck();
        case "wallet_cannot_build":
          return ongoing(
            advice,
            failure.hint?.balance ? callOnce("sodax_get_balance", failure.hint.balance) : stuck().nextAction,
          );
        case "trustline_room":
          return ongoing(advice, external("wallet_setup", answer()));
        default:
          return sent ? stuck() : final(advice, NONE);
      }
    case "SWAP_MISMATCH":
    case "BRIDGE_MISMATCH":
      // Built wrong: never signed. After a send (a cancel built wrong), the swap itself still stands.
      return sent ? stuck() : final(advice, NONE);
    case "DESTINATION_NOT_READY":
      return ongoing(advice, external("destination_not_ready", answer()));
    case "API_KEY_REQUIRED":
    case "QUOTE_KEY_MISMATCH":
      return ongoing(advice, external("api_key"));
    case "SECRET_REJECTED":
      return ongoing(advice, external("secret_exposed", field ? provide([field], answer()) : undefined));
  }
}
