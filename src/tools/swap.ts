/**
 * Swap tools: the `swap` profile. Registered only while the kill switch is on
 * (the default) and the connection sent an API key (see services/profiles.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChainKeys } from "@sodax/types";
import { z } from "zod";
import { SWAP_USD_WARN } from "../constants.js";
import { getRequestContext } from "../services/requestContext.js";
import { type NonEvmSourceType, isHubChain, pinnedSourceOf } from "../services/sodax.js";
import { type BalanceResult, readBalances } from "../services/swap/balance.js";
import { type CancelResult, cancelSwap } from "../services/swap/cancel.js";
import { type ActionError, RETRYABLE_CODES } from "../services/swap/errors.js";
import { SIGNER_READ, isAnyTxHash } from "../services/swap/nonEvmSource.js";
import { type SwapQuote, quoteSwap } from "../services/swap/quote.js";
import { type Resolution, resolveToken } from "../services/swap/resolver.js";
import { type SecretField, secretRefusalText } from "../services/swap/secrets.js";
import { type SwapsApiToken, getSwapCatalog } from "../services/swap/tokens.js";
import {
  DEPOSIT_SAFE,
  DEPOSIT_SAFE_UNALERTED,
  type TrackOutcome,
  type TrackResult,
  trackSwapWaiting,
} from "../services/swap/track.js";
import { amountText } from "../services/swap/units.js";
import { registerActionTool } from "./actionTool.js";

/**
 * `schema`, plus the SECRET_REJECTED refusal for a value that fails it and looks like a secret: the
 * handler's own screening never sees a value zod rejects. A tx-hash field takes every source family's
 * format, which some key shapes fit too, so it's screened even when it passes.
 */
function screened(schema: z.ZodType<string>, field: SecretField = {}) {
  return schema.superRefine((value, ctx) => {
    const screen = field.txHash || !schema.safeParse(value).success;
    const refusal = screen ? secretRefusalText(value, field) : undefined;
    if (refusal) ctx.addIssue({ code: "custom", message: refusal });
  });
}

// Functions, so each field gets its own schema: one reused within a tool becomes a `$ref` in its JSON schema.
const textArg = (max: number, min = 0) => screened(z.string().trim().min(min).max(max));
const chainArg = () => textArg(64, 1);
const tokenArg = () => textArg(128, 1);
const addressArg = () => textArg(128).optional();
const txHashArg = () =>
  screened(z.string().trim().refine(isAnyTxHash, "Must be a transaction hash as the wallet shows it."), {
    txHash: true,
  });
const quoteIdArg = () => screened(z.string().trim().toLowerCase().uuid(), { notHex64: "a quoteId" });

// What track and cancel take to find the swap. The quote is bound to the API key that made it.
const swapArgs = {
  txHash: txHashArg().describe(
    "Hash of the swap step's transaction on the source chain, as the wallet shows it (EVM: 0x and 64 hex characters), not the approve's. From a batch, the transaction hash wallet_getCallsStatus reports, not the batch id.",
  ),
  quoteId: quoteIdArg().optional().describe("The quoteId from sodax_swap_quote."),
  chain: chainArg()
    .optional()
    .describe('Source chain name, key or EVM chain id ("42161"); needed only without quoteId.'),
};
const swapActionHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerSwapTools(server: McpServer): void {
  registerActionTool(
    server,
    "sodax_resolve_token",
    "Look up a token on a chain: its address, decimals and hub asset. The other swap tools take symbols themselves; use this when one returns UNKNOWN_TOKEN. Returns resolved, ambiguous (ask the user to pick; never guess) or not_found (with suggestions).",
    {
      chain: chainArg().describe(
        'Chain name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161").',
      ),
      query: tokenArg().describe('Token symbol ("USDC"), contract address, or "native" for the chain\'s gas token.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ chain, query }) => {
      const resolution = resolveToken(await getSwapCatalog(), chain, query);
      return { ...resolution, nextStep: resolveNextStep(resolution) };
    },
  );

  registerActionTool(
    server,
    "sodax_get_balance",
    "Read a wallet's native balance on a chain and, optionally, one token's. The quote doesn't check balances; use this when the user isn't sure they hold enough. Figures can be up to 5 seconds old; after sending a swap, follow it with sodax_swap_track rather than re-reading balances.",
    {
      chain: chainArg().describe(
        'Chain name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161").',
      ),
      address: textArg(128, 1).describe("The wallet's address on that chain."),
      token: tokenArg()
        .optional()
        .describe('Token symbol ("USDC"), contract address, or "native". Omit for the native balance only.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async args => {
      const balances = await readBalances(args);
      return { ...balances, nextStep: balanceNextStep(balances) };
    },
  );

  registerActionTool(
    server,
    "sodax_swap_quote",
    "Quote a cross-chain swap. With fromAddress it returns the transactions for the user's wallet to sign (approve if needed, then the swap); without it, a price only. This server never signs or moves funds.",
    {
      fromChain: chainArg().describe(
        'Source chain: name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161"). If a swap can\'t start there, the error lists the chains it can.',
      ),
      fromToken: tokenArg().describe('Token the user sends: symbol ("USDC"), contract address, or "native".'),
      toChain: chainArg().describe("Destination chain name, ticker, key or EVM chain id."),
      toToken: tokenArg().describe('Token the user receives: symbol, contract address, or "native".'),
      amount: z
        .union([textArg(96, 1), z.number()])
        .describe('Amount the user sends, in token units, as a plain decimal string: "0.5", not "1,000" or "1e6".'),
      fromAddress: addressArg().describe(
        "The user's wallet on the source chain. Pass it whenever you know it; omit it only for a price.",
      ),
      toAddress: addressArg().describe(
        "Recipient on the destination chain. Defaults to fromAddress when both chains are EVM.",
      ),
      slippageBps: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Most the received amount may fall below the quote, in basis points (100 = 1%)."),
      deadlineMinutes: z
        .number()
        .int()
        .min(5)
        .max(60)
        .default(15)
        .describe("Minutes the user has to send the swap before the quote expires."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async args => {
      const quote = await quoteSwap({ ...args, amount: amountText(args.amount) }, getRequestContext().partnerFee);
      // Nothing submits the deposit unless track is called; a field is harder to miss than a sentence.
      const afterSend: AfterSend | undefined =
        quote.status === "ready"
          ? { tool: "sodax_swap_track", args: { quoteId: quote.quoteId }, needs: "txHash" }
          : undefined;
      return { ...quote, ...(afterSend && { afterSend }), nextStep: quoteNextStep(quote) };
    },
  );

  registerActionTool(
    server,
    "sodax_swap_track",
    "Submit and track a swap once the user's wallet has sent its swap transaction. Call it right after sending; while the result has retryAfterSec, call again (each call waits up to 20 seconds for the swap to move on). A successful result without retryAfterSec is final; after an error, follow its nextStep. Repeated calls never resubmit. It checks the transaction on chain before submitting. This server never signs or moves funds.",
    swapArgs,
    swapActionHints,
    async args => {
      const result = await trackSwapWaiting(args);
      return { ...result, nextStep: trackNextStep(result) };
    },
    afterSendAdvice("sodax_swap_track", "swap"),
  );

  registerActionTool(
    server,
    "sodax_swap_cancel",
    "Cancel a submitted swap that hasn't been filled. The first call returns the cancel transaction for the user's wallet to sign; once it's sent, call again with cancelTxHash and this server relays it, or for a swap from Sonic confirms it on the hub. This server never signs or moves funds.",
    {
      ...swapArgs,
      cancelTxHash: txHashArg()
        .optional()
        .describe(
          "Hash of the cancel transaction as the wallet shows it, once the user's wallet has sent the cancel step.",
        ),
    },
    swapActionHints,
    async args => {
      const result = await cancelSwap(args);
      return { ...result, nextStep: cancelNextStep(result) };
    },
    afterSendAdvice("sodax_swap_cancel", "cancel"),
  );
}

// Retries of a failure that may pass, so a stuck one ends with an answer for the user.
const MAX_CALLS = 10;
const GIVE_UP =
  "tell the user this server can't follow the swap right now, that they must not send it again, and to give SODAX support the swap's transaction hash.";

/** What a ready quote tells the agent to call once the wallet has sent the swap. */
export interface AfterSend {
  tool: "sodax_swap_track";
  args: { quoteId: string };
  needs: "txHash";
}

/**
 * Any failure after the user's wallet sent something: one that may pass is the same call again, a few
 * times at most, and none is a reason to send the swap again. Nothing is claimed about the tx: the
 * failure may have come before it was checked.
 */
const afterSendAdvice = (tool: string, sent: string) => (failure: ActionError, seconds: number) =>
  RETRYABLE_CODES.includes(failure.code)
    ? `Call ${tool} again in ${seconds} seconds with the same arguments, at most ${MAX_CALLS} times, and don't send the ${sent} again meanwhile. If it still fails, stop: ${GIVE_UP}`
    : `${failure.nextStep} The user must not send the swap again.`;

// A swap deposits the token the user sends into its hub vault and withdraws the one they receive.
const RESTRICTED = {
  withdrawOnly: "is withdraw-only: use it only as the token the user receives",
  depositOnly: "is deposit-only: use it only as the token the user sends",
} as const;

// The agent knows which call returned UNKNOWN_TOKEN; a lookup of its own is most often for a quote.
const UNKNOWN_TOKEN_CALL = "the call that returned UNKNOWN_TOKEN (sodax_swap_quote if there was none)";
const USE_RESOLVED = `Pass chain.key and token.address to ${UNKNOWN_TOKEN_CALL}; a quote's amount stays in token units.`;

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

/**
 * Built from catalog symbols, addresses and chain names only, never from the caller's
 * query or a token's free-text name.
 */
export function resolveNextStep(resolution: Resolution): string {
  const chain = resolution.chain.name;
  switch (resolution.status) {
    case "resolved": {
      const { token } = resolution;
      const named = `${token.symbol} on ${chain}`;
      // The same address can be a different token on each chain.
      const found = resolution.matchedBy === "address" ? `That address is ${named}. ` : "";
      const restricted = token.access ? `${named} ${RESTRICTED[token.access]}. ` : "";
      return `${found}${restricted}${USE_RESOLVED}`;
    }
    case "ambiguous": {
      // Two candidates can share a symbol in any case (bridged and native USDC); the address tells them apart.
      const { candidates } = resolution;
      const labels = candidates.map(token => {
        const twins = candidates.filter(other => other.symbol.toLowerCase() === token.symbol.toLowerCase());
        return twins.length > 1 ? `${token.symbol} (${twinAddress(token, twins)})` : token.symbol;
      });
      const ask =
        labels.length === 1
          ? `whether they mean ${labels[0]} on ${chain}`
          : `which of ${labels.join(", ")} on ${chain} they mean`;
      return `Ask the user ${ask}, then pass its address to ${UNKNOWN_TOKEN_CALL}.`;
    }
    case "not_found": {
      const [first] = resolution.suggestions;
      const nearest = first && `${first.symbol}${first.isNative ? " (the native token)" : ""}`;
      if (resolution.otherChains) {
        const found = resolution.otherChains.map(other => `${other.token.symbol} on ${other.chain.name}`).join(", ");
        // A symbol listed elsewhere may still be a near miss here: WETH on Arbitrum is most likely its ETH.
        if (nearest) {
          return `No swap token on ${chain} matches that; it is listed as ${found}, and the nearest on ${chain} is ${nearest}. Ask the user which they mean, then call sodax_resolve_token again with that chain.`;
        }
        return `No swap token on ${chain} matches that; it is ${found}. Confirm the chain with the user, then call sodax_resolve_token again with the chain the user confirms.`;
      }
      if (!nearest) return `No swap token matches on ${chain}; confirm the chain and token with the user.`;
      return `No swap token matches on ${chain}; ask the user whether they mean ${nearest} or another suggestion.`;
    }
  }
}

/** Head and tail, as a prefix alone repeats (every Hedera address starts `0x00000000`); in full when those collide. */
function twinAddress(token: SwapsApiToken, twins: SwapsApiToken[]): string {
  const short = shortAddress(token.address);
  return twins.some(other => other !== token && shortAddress(other.address) === short) ? token.address : short;
}

function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/**
 * Warns, never refuses: an agent passing base units as token units shows up as a huge value, and an
 * output with no price skips the off-market check.
 */
function usdWarning(usdValue: string | null, usdOut: string | null): string {
  if (usdValue === null) {
    return " Its USD value couldn't be checked, so confirm a large amount with the user before anything is signed.";
  }
  const unpriced =
    usdOut === null
      ? " What they receive has no USD price here, so the rate wasn't checked against the market: confirm the amounts with the user before anything is signed."
      : "";
  const value = Number(usdValue);
  if (value <= SWAP_USD_WARN) return unpriced;
  return ` This swap is worth about ${usd(value)}, above this server's warning level of ${usd(SWAP_USD_WARN)}: confirm the amount with the user before anything is signed.${unpriced}`;
}

function quoteNextStep(quote: SwapQuote): string {
  const { from, to, partnerFee } = quote;
  const fee = partnerFee ? `, including a ${partnerFee.amount} ${partnerFee.symbol} partner fee,` : "";
  const show = `Show the user they send ${from.amount} ${from.symbol} on ${from.chain.name}${fee} and receive about ${to.expectedAmount} ${to.symbol} on ${to.chain.name} (at least ${to.minimumAmount})`;
  const warning = usdWarning(quote.usdValue, quote.usdOut);
  if (quote.status === "price_only") {
    const needed = quote.missing.map(field =>
      field === "fromAddress"
        ? `fromAddress (their wallet on ${from.chain.name})`
        : `toAddress (their address on ${to.chain.name})`,
    );
    return `${show}.${warning} To prepare the swap, call sodax_swap_quote again with ${needed.join(" and ")}.`;
  }
  // A smart-contract wallet may not exist, or have the same owner, at its address on another chain.
  const sameAddress =
    from.chain.key !== to.chain.key && quote.toAddress.toLowerCase() === quote.fromAddress.toLowerCase()
      ? ` (the sender's own address: make sure they control it on ${to.chain.name})`
      : "";
  const batch = quote.batch
    ? " (or, if the wallet batches, wallet_sendCalls with the batch's params plus calls: the {to, value, data} of each step it replaces, in order, once any step it doesn't replace is mined)"
    : "";
  const [first] = quote.steps;
  const send =
    "chainType" in first
      ? `Once they confirm, have their ${from.chain.name} wallet send the swap step before it expires: ${SIGN_NON_EVM_TX[first.chainType]}.`
      : `Their wallet must be on ${from.chain.name} (chain id ${first.chainId}) to send the steps; switch it there first if it isn't. Once they confirm, have their wallet send the steps in order before it expires, each mined before the next (a swap sent before its approve is mined fails)${batch}.`;
  return [
    `${show} at ${quote.toAddress}${sameAddress}; the quote expires at ${quote.expiresAt}.${warning}`,
    "Balances aren't checked here; sodax_get_balance reads them.",
    send,
    `Then call sodax_swap_track with the quoteId and the swap transaction's hash, even if the quote has expired by then: track is what submits the swap${isHubChain(from.chain.key) ? "" : ", or starts its refund"}.`,
  ].join(" ");
}

// How a family's wallet sends the SDK's raw tx (`steps[].tx`; bigints are decimal strings, bytes base64).
const SIGN_NON_EVM_TX: Record<NonEvmSourceType, string> = {
  NEAR: "one transaction from signerId to params.contractId calling params.method with params.args, attaching params.deposit (yoctoNEAR) and params.gas",
  SOLANA:
    "data is an unsigned v0 transaction (base64) with the user as fee payer, which the wallet signs and sends at once: its blockhash expires in about a minute, and if it expires unsent, call this tool again with the same arguments for a new one",
  STELLAR:
    "data is the transaction envelope (XDR, public network), which the wallet signs and submits; any other transaction from the account first makes it unusable",
  SUI: "data is the transaction as JSON (Transaction.from), with its sender set, which that account's wallet signs and executes",
  INJECTIVE:
    "the wallet signs signedDoc in direct mode (bodyBytes and authInfoBytes in base64) and broadcasts it, or an EIP-712 wallet sends the same contract execution from that account; any other transaction from the account first makes the signed one unusable",
};

// A swap from the hub is an intent there already: it's filled or, once expired, refunded without an operator.
const safe = ({ alerted, chain }: { alerted: boolean; chain: { key: string; name: string } }) =>
  isHubChain(chain.key)
    ? `tell the user the swap is on ${chain.name} and safe: unless a solver fills it first, it's refunded to them once its quote expires, and they must not send it again`
    : alerted
      ? DEPOSIT_SAFE
      : DEPOSIT_SAFE_UNALERTED;
const isNonEvmChain = (chainKey: string) => {
  const family = pinnedSourceOf(chainKey)?.family;
  return family !== undefined && family !== "EVM";
};
/** A tx its node can't confirm: a non-EVM node can't tell one in flight from one never sent; a batch id is EVM's. */
const unseen = ({ key, name }: { key: string; name: string }) =>
  isNonEvmChain(key)
    ? `${name} hasn't confirmed this transaction yet. Check that the user's wallet really sent it and that this is its transaction hash`
    : `${name} hasn't seen this transaction. Check that the user's wallet really broadcast it and that this is its transaction hash, not a batch id`;
// Its reader doesn't name the sender, so a deposit for another quote may be anyone's.
const senderUnknown = (chainKey: string) => {
  const family = pinnedSourceOf(chainKey)?.family;
  return family !== undefined && family !== "EVM" && !SIGNER_READ.includes(family);
};
const again = (seconds: number) => `call sodax_swap_track again in about ${seconds} seconds`;
const retryRefund = (tool: string, seconds: number) =>
  `To retry the refund, call ${tool} again in about ${seconds} seconds, at most ${MAX_CALLS} times, then stop.`;
// Each track call waits for the next step itself, so an agent that can't sleep calls straight back.
// A slow solver can hold a healthy swap for minutes: about 10 minutes of calls before giving up.
const MAX_POLLS = 30;
const POLL = `call sodax_swap_track again (it waits up to 20 seconds for the next step), at most ${MAX_POLLS} times at this step. If it's still at this step after that, stop: tell the user the swap is still in progress, that they must not send it again, and that they can track it later with this transaction hash.`;

function notSubmittedNextStep(result: Extract<TrackResult, { status: "not_submitted" }>): string {
  if (result.reason === "not_a_deposit") {
    return "That transaction isn't this quote's swap (on an EVM chain it may be the approve, or a swap call that failed inside a batch); ask for the swap transaction's hash.";
  }
  const deposit = safe(result);
  switch (result.reason) {
    case "deposit_mismatch":
      if (senderUnknown(result.chain.key)) {
        return `That transaction is a SODAX deposit, but not this quote's, and this server can't tell who sent it. If the user sent it from another quote, track it with that quoteId; if they no longer have it, ${deposit}. If it isn't theirs, ask for this swap's transaction hash.`;
      }
      return `That transaction is a SODAX deposit for another quote: track it with the quoteId it was made from. Without that quoteId, ${deposit}.`;
    case "other_sender":
      return `That transaction sent this quote's swap from another address than its fromAddress, so this server can't submit it: ${deposit}.`;
    case "quote_used":
      return `This quote was already used by another transaction, so this one can't become a swap: ${deposit}.`;
    case "multiple_deposits":
      return `That transaction holds other SODAX deposits besides this swap, so this server can't submit it: ${deposit}. Next time, send each swap as its own transaction.`;
  }
}

const OUTCOME: Record<TrackOutcome, string> = {
  cancelled: "The swap was cancelled; its funds go back to the user.",
  refunding: "The swap couldn't be filled and is being refunded to the user.",
  abandoned: "The swap couldn't be processed.",
  cancel_to_recover: "The swap wasn't filled.",
  unknown: "The swap failed.",
};

/** Built from enums, catalog names, the cached quote summary and checked hashes only. */
export function trackNextStep(result: TrackResult): string {
  const chain = result.chain.name;
  switch (result.status) {
    case "awaiting_source_confirmation":
      return result.seenOnChain
        ? `The swap transaction isn't confirmed on ${chain} yet; don't resend it, and ${POLL}`
        : `${unseen(result.chain)}; if it was never sent, stop tracking it. Otherwise don't resend it, and ${
            result.stopAfter
              ? `call sodax_swap_track again in about ${result.retryAfterSec} seconds until ${result.stopAfter}, then once more and follow that answer.`
              : POLL
          }`;
    case "source_not_found": {
      // A sped-up or replaced tx has a new hash; its deposit still matches the quote.
      const quoteId = result.quoteId ? "the same quoteId" : "its quoteId";
      // Public non-EVM nodes keep recent txs only, so an older swap reads as unknown too.
      if (isNonEvmChain(result.chain.key)) {
        return `${chain}'s node doesn't have this transaction: it may be older than the node keeps, or not a transaction on ${chain}. Check that this is the swap transaction's hash on ${chain}. If the wallet shows it was sent, this server can't follow it: the user must not send it again, and can check it in a ${chain} explorer. Only if the wallet shows it was never sent: nothing was swapped, so stop tracking it and quote again if the user still wants to swap.`;
      }
      return `${chain} hasn't seen this transaction. Check that this is the swap transaction's hash on ${chain}, not a batch id. If the user's wallet sped it up or replaced it, call sodax_swap_track with the new transaction's hash and ${quoteId}. Only if the wallet shows it was never sent: nothing was swapped, so stop tracking it and quote again if the user still wants to swap.`;
    }
    case "source_failed":
      return `The swap transaction failed on ${chain}: nothing was swapped, only gas was spent. Quote again if the user wants to retry.`;
    case "not_submitted":
      return notSubmittedNextStep(result);
    case "not_submitted_unknown_quote":
      // Only a deposit named by its quoteId alerts.
      if (result.isDeposit && result.quoteId) return `This server has no quote for that deposit: ${safe(result)}.`;
      return result.isDeposit
        ? "This server has no record of that SODAX deposit. If it came from sodax_swap_quote, call sodax_swap_track again with the same arguments plus its quoteId; otherwise track it where it was made. Either way, the user must not send it again."
        : `That transaction isn't a SODAX swap deposit on ${chain}; ask for the swap transaction's hash.`;
    case "expired_refunding":
      return isHubChain(result.chain.key)
        ? `The swap expired before it was submitted: unless a solver filled it first, its intent on ${chain} is refunded to the user, and they must not send it again.`
        : "The swap won't be filled: its deposit is being refunded to the user, and they must not send it again.";
    case "expired_unsubmitted":
      return `The swap won't be filled and its refund couldn't start: ${safe(result)}. ${retryRefund("sodax_swap_track", result.retryAfterSec)}`;
    case "submit_refused":
      return isHubChain(result.chain.key)
        ? `The swap service refused this swap: ${safe(result)}. Then ${again(result.retryAfterSec)}.`
        : `The swap service refused this deposit, so it won't be swapped: ${safe(result)}. Once the quote expires this server starts the refund: ${again(result.retryAfterSec)}.`;
    case "queued":
      return `The swap is queued for processing; ${POLL}`;
    case "in_progress":
      return `The swap is being processed (${result.stage}); ${POLL}`;
    case "solved": {
      // Solved is the fill on the hub; another destination gets the tokens one cross-chain hop later.
      const fill = result.fillTxHash ? ` (fill tx ${result.fillTxHash})` : "";
      const promised = result.minimumReceived;
      if (!promised) {
        return `The swap is filled on the SODAX hub${fill}; to a chain other than Sonic the tokens arrive after one more cross-chain hop. Don't send it again.`;
      }
      const atLeast = `at least ${promised.amount} ${promised.symbol}`;
      return result.delivery === "complete"
        ? `The swap is complete on ${promised.chainName}: the user received ${atLeast}${fill}.`
        : `The swap is filled${fill}: ${atLeast} is on its way to ${promised.chainName}, arriving after one more cross-chain hop; sodax_get_balance on the recipient shows it arrive. Don't send it again.`;
    }
    case "failed":
      return `${OUTCOME[result.outcome]} ${failedNextStep(result)}`;
    case "unknown":
      return "The swap service reports a status this server doesn't know, so it can't tell how the swap ended: stop tracking it, and tell the user its outcome isn't known here yet and that they must not send it again.";
  }
}

function failedNextStep({ canCancel, outcome }: Extract<TrackResult, { status: "failed" }>): string {
  if (canCancel) return "The user can cancel it with sodax_swap_cancel to get the funds back.";
  if (outcome === "cancelled" || outcome === "refunding") return "There's nothing to do here.";
  return "The deposit is safe on chain and SODAX operators will recover it; the user must not send it again.";
}

const NOT_CANCELLABLE: Record<Extract<CancelResult, { status: "not_cancellable" }>["reason"], string> = {
  not_submitted:
    "The swap service has no record of this swap, so it can't be cancelled here. If it came from sodax_swap_quote, call sodax_swap_track with its quoteId first; a swap made elsewhere is cancelled where it was made.",
  solved: "The swap is already complete; there's nothing to cancel.",
  cancelled: "The swap is already cancelled.",
  refunding: "The swap is already being refunded to the user.",
  not_on_hub_yet: "The swap service hasn't processed this swap yet; call sodax_swap_track until it has, then cancel.",
  not_sent:
    "The swap transaction isn't confirmed, or it failed, so nothing was sent and there's nothing to cancel yet. If it's still pending, call sodax_swap_cancel again once it's confirmed; on an EVM chain the user can also cancel or replace it in their wallet.",
};

/** Built from enums and catalog names only. */
export function cancelNextStep(result: CancelResult): string {
  const chain = result.chain.name;
  switch (result.status) {
    case "not_cancellable":
      // A tx on the hub that created an intent needs no record to be refunded: the backend's canceller reads the chain.
      if (result.reason === "not_submitted" && isHubChain(result.chain.key)) {
        return `The swap service has no record of this swap, so it can't be cancelled here. If that transaction created a swap on ${chain}, its intent is there already: unless a solver fills it first, it's refunded to the user once it expires, and they must not send it again.`;
      }
      return NOT_CANCELLABLE[result.reason];
    case "deposit_unsubmitted":
      if (isHubChain(result.chain.key)) {
        return `The swap is on ${chain} but was never submitted, so it can't be cancelled here: don't call sodax_swap_track, which would submit it. Unless a solver fills it first, it's refunded to the user once the quote expires: call sodax_swap_cancel again with the same arguments in about ${result.retryAfterSec} seconds. The user must not send it again.`;
      }
      return `The swap's deposit is on ${chain} but was never submitted, so it won't be swapped unless sodax_swap_track is called: don't call it. To get the funds back, call sodax_swap_cancel again with the same arguments in about ${result.retryAfterSec} seconds, once the quote has expired, and this server starts the refund. The deposit is safe meanwhile; the user must not send it again.`;
    case "expired_unsubmitted":
      return `The swap won't be filled and its refund couldn't start: ${safe(result)}. ${retryRefund("sodax_swap_cancel", result.retryAfterSec)}`;
    case "ready": {
      const [step] = result.steps;
      const how = "chainType" in step ? ` (${SIGN_NON_EVM_TX[step.chainType]})` : "";
      return `Have the user's wallet send the cancel step on ${chain}${how}, then call sodax_swap_cancel again with the same arguments plus cancelTxHash.`;
    }
    case "cancel_awaiting_confirmation":
      return `The cancel isn't confirmed on ${chain} yet; call sodax_swap_cancel again in about ${result.retryAfterSec} seconds, and don't resend it. Only if the wallet shows it was never sent (a Solana one expires in about a minute), call sodax_swap_cancel without cancelTxHash for a new one.`;
    case "cancel_failed":
      return `The cancel transaction failed on ${chain}; only gas was spent. Call sodax_swap_cancel without cancelTxHash for a new one.`;
    case "not_a_cancel_tx":
      return "That transaction isn't the cancel for this swap; ask for the cancel transaction's hash.";
    case "cancel_relayed":
      return "The cancel is on its way to the hub; call sodax_swap_track to see the swap reported as cancelled.";
    case "cancel_confirmed":
      return "The swap is cancelled on the hub and the funds are on their way back to the user; call sodax_swap_track to see it reported as cancelled.";
  }
}
