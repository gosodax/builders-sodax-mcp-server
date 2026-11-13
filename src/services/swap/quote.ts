/**
 * Quote a swap and, given the sender's address, build the transactions to sign.
 * Returns structure only; the tool words the next step.
 *
 * Nothing here signs, holds funds or submits anything: the user's wallet sends
 * the steps, and the cached quote is what tracking later submits.
 */

import { ZERO_ADDRESS_PATTERN, sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import type { PartnerFee } from "../partnerFee.js";
import { callerKeyHash } from "../requestContext.js";
import {
  createIntentPayload,
  encodeRecipient,
  intentChainId,
  intentHash,
  isHubChain,
  packagedToken,
  stellarRecipientCheckable,
  userHubWallet,
} from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { type RecipientCheck, checkRecipient } from "./destination.js";
import { ActionError } from "./errors.js";
import { checkQuoteRoom, putQuote } from "./quoteCache.js";
import { checkAddress, resolveExactly } from "./resolver.js";
import { chainRead, configDisagrees, isHubSource, sourceChainFor } from "./source.js";
import { swapMismatch } from "./sources/evm.js";
import type { SourceChain, SwapBatch, SwapStep } from "./sources/types.js";
import {
  type BuiltIntent,
  type IntentRequest,
  buildIntent,
  checkAllowance,
  getDeadline,
  getQuote,
  leavesTimeToSend,
} from "./swapsApi.js";
import { type SwapCatalog, type SwapChain, type SwapsApiToken, canUseAs, getSwapCatalog } from "./tokens.js";
import { formatUnits, parseUnits } from "./units.js";
import { usdValue } from "./usd.js";

export interface QuoteInput {
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  amount: string;
  fromAddress?: string;
  toAddress?: string;
  slippageBps: number;
  deadlineMinutes: number;
}

interface Side {
  chain: ChainInfo;
  symbol: string;
  address: string;
}

interface QuoteSummary {
  from: Side & { amount: string };
  to: Side & { expectedAmount: string; minimumAmount: string };
  slippageBps: number;
  partnerFee?: { bps: number; amount: string; symbol: string };
  /** The amount sent in USD (2 decimals), or null when no recent price is known. */
  usdValue: string | null;
  /** The expected amount received in USD, likewise. */
  usdOut: string | null;
}

export type SwapQuote =
  | (QuoteSummary & { status: "price_only"; missing: ("fromAddress" | "toAddress")[] })
  | (QuoteSummary & {
      status: "ready";
      quoteId: string;
      /** The hub's id of the intent, for `GET /intent/:intentHash` and the logs. */
      intentHash: string;
      /** ISO time; the swap step must be mined, and tracked, before it. */
      expiresAt: string;
      /** Seconds from now to `expiresAt`, for agents that can't do time arithmetic. */
      expiresInSec: number;
      fromAddress: string;
      toAddress: string;
      checks: { balance: "not_checked"; recipient: RecipientCheck };
      steps: SwapStep[];
      batch?: SwapBatch;
    });

// The least share of the input's market value (net of the partner fee) a quote's output may be worth.
const MIN_MARKET_SHARE = 0.9;
// The swap service doesn't say how much it needs; swaps worth this much in USD are usually quoted.
const USUAL_MIN_USD = 1.5;

/**
 * AMOUNT_TOO_LOW names an amount of the token worth about USUAL_MIN_USD, so the agent asks once
 * instead of guessing. Only a hint: unpriced, or already worth that much, keeps the plain advice.
 */
function suggestAmount(
  error: ActionError,
  token: { decimals: number; symbol: string },
  amount: bigint,
  usd: number | null,
): ActionError {
  if (usd === null || usd <= 0 || usd >= USUAL_MIN_USD) return error;
  const base = BigInt(Math.ceil((USUAL_MIN_USD / usd) * Number(amount)));
  // Up to three significant digits, so the agent quotes a round figure.
  const step = 10n ** BigInt(Math.max(base.toString().length - 3, 0));
  const suggestedAmount = formatUnits(((base + step - 1n) / step) * step, token.decimals);
  return new ActionError("AMOUNT_TOO_LOW", error.message, {
    nextStep: `The swap service usually quotes swaps worth about $${USUAL_MIN_USD} or more: ask the user to send at least ${suggestedAmount} ${token.symbol}.`,
    details: { suggestedAmount },
  });
}

export async function quoteSwap(input: QuoteInput, partnerFee?: PartnerFee): Promise<SwapQuote> {
  const catalog = await getSwapCatalog();
  const from = resolveSide(catalog, input.fromChain, input.fromToken, "from");
  const to = resolveSide(catalog, input.toChain, input.toToken, "to");
  // Only a chain track can prove the swap on: nothing else would submit it. The chain id and swap
  // contract are pinned from the SDK config.
  const source = sourceChainFor(catalog, from.chain);
  const { swapContract } = source;
  // Five EVM chains share one asset manager, so the live chain id must agree with the pinned one.
  if (source.chainId !== undefined && from.config.chainId !== source.chainId) {
    throw configDisagrees(from.chain.key, "chainId");
  }
  // An EVM sender's address is theirs on an EVM destination too; any other pair needs the recipient given.
  const defaultsToSender = to.config.type === "EVM" && source.adapter.family === "EVM";

  const amount = parseUnits(input.amount, from.token.decimals);
  const fromAddress = input.fromAddress ? checkAddress(input.fromAddress, from.chain, "fromAddress") : undefined;
  if (fromAddress !== undefined) source.adapter.checkSender?.(fromAddress);
  const toAddress = input.toAddress
    ? checkAddress(input.toAddress, to.chain, "toAddress")
    : defaultsToSender
      ? fromAddress
      : undefined;
  const ready = fromAddress !== undefined && toAddress !== undefined;
  const { probe } = source.adapter;
  // Before any upstream call, so a key at its cap of open quotes costs nothing.
  if (ready) checkQuoteRoom(callerKeyHash());

  const usdSent = usdValue(from.token.hubAsset, formatUnits(amount, from.token.decimals));
  const [quoted, deadline, usd] = await Promise.all([
    getQuote({
      tokenSrc: from.token.address,
      tokenSrcChainKey: from.chain.key,
      tokenDst: to.token.address,
      tokenDstChainKey: to.chain.key,
      amount,
      partnerFee,
    }).catch(async (error: unknown) => {
      throw error instanceof ActionError && error.code === "AMOUNT_TOO_LOW"
        ? suggestAmount(error, from.token, amount, await usdSent)
        : error;
    }),
    ready ? getDeadline(input.deadlineMinutes * 60) : undefined,
    usdSent,
    // A dead source RPC fails the quote before any steps, not the track after the user has sent them: where building
    // the swap doesn't read the chain, the source reads it first.
    ready && probe ? chainRead(from.chain, () => probe(from.chain.key)) : undefined,
  ]);
  const minOutput = (quoted * BigInt(10_000 - input.slippageBps)) / 10_000n;
  if (minOutput === 0n) {
    const error = new ActionError("AMOUNT_TOO_LOW", "The amount is too small: the minimum received would be zero.");
    throw suggestAmount(error, from.token, amount, usd);
  }
  const fee = partnerFee ? (amount * BigInt(partnerFee.bps)) / 10_000n : 0n;
  // The solver's amount passes through the Swaps API unchecked. The oracle was just read, so no added wait.
  const usdOut = await usdValue(to.token.hubAsset, formatUnits(quoted, to.token.decimals));
  const usdNet = usd === null ? null : usd * (1 - (partnerFee?.bps ?? 0) / 10_000);
  if (usdNet !== null && usdOut !== null && usdOut < usdNet * MIN_MARKET_SHARE) {
    logger.warn(
      {
        "chain.key": from.chain.key,
        "dst_chain.key": to.chain.key,
        "token.address": from.token.address,
        "dst_token.address": to.token.address,
      },
      "A swap quote is off market",
    );
    throw new ActionError("PRICE_OFF_MARKET", "The quoted amount is worth far less than the amount sent.", {
      details: { chainKey: from.chain.key, usdValue: usd?.toFixed(2), usdOut: usdOut.toFixed(2) },
    });
  }

  const summary: QuoteSummary = {
    from: { ...describe(from), amount: formatUnits(amount, from.token.decimals) },
    to: {
      ...describe(to),
      expectedAmount: formatUnits(quoted, to.token.decimals),
      minimumAmount: formatUnits(minOutput, to.token.decimals),
    },
    slippageBps: input.slippageBps,
    usdValue: usd?.toFixed(2) ?? null,
    usdOut: usdOut?.toFixed(2) ?? null,
    ...(partnerFee && {
      partnerFee: { bps: partnerFee.bps, amount: formatUnits(fee, from.token.decimals), symbol: from.token.symbol },
    }),
  };

  if (!ready || deadline === undefined) {
    const missing: ("fromAddress" | "toAddress")[] = [];
    if (!fromAddress) missing.push("fromAddress");
    if (!toAddress && !defaultsToSender) missing.push("toAddress");
    return { status: "price_only", ...summary, missing };
  }

  // The live chain config must agree with the pinned swap contract.
  const live = from.config.swapContract;
  if (live && !same(live, swapContract)) throw configDisagrees(from.chain.key, "swapContract");

  const recipient = await checkRecipient({
    chainKey: to.chain.key,
    chainType: to.config.type,
    chainName: to.chain.name,
    token: to.token,
    address: toAddress,
    amount: quoted,
  });
  const request: IntentRequest = {
    srcChainKey: from.chain.key,
    dstChainKey: to.chain.key,
    inputToken: from.token.address,
    outputToken: to.token.address,
    inputAmount: amount,
    minOutputAmount: minOutput,
    deadline,
    srcAddress: fromAddress,
    dstAddress: toAddress,
    partnerFee,
  };
  // A native token needs no approval. The hub wallet is looked up to check the intent's creator.
  const [built, approved, hubWallet] = await Promise.all([
    buildIntent(request),
    from.token.isNative || checkAllowance(request),
    userHubWallet(from.chain.key, fromAddress).catch(() => {
      throw new ActionError("UPSTREAM_UNAVAILABLE", "Couldn't look up the user's SODAX hub wallet.");
    }),
  ]);
  const want = { from: from.token, to: to.token, fee, hubWallet };
  const intentMismatch = findIntentMismatch(request, source, want, built);
  if (intentMismatch) throw swapMismatch(request, intentMismatch, built.tx);
  const prepared = await source.adapter.prepareSwap(
    { ...source, chain: from.chain },
    { request, built, approved, symbol: from.token.symbol },
  );
  // The builds above can take most of a minute, which a short deadline can't spare.
  if (!leavesTimeToSend(deadline)) {
    throw new ActionError("DEADLINE_TOO_SHORT", "Preparing the swap left too little time to send it.");
  }

  const { quoteId } = putQuote({
    ...request,
    intent: built.intent,
    relayData: built.relayData,
    keyHash: callerKeyHash(),
    minimumReceived: { amount: summary.to.minimumAmount, symbol: to.token.symbol, chainName: to.chain.name },
  });
  return {
    status: "ready",
    ...summary,
    quoteId,
    intentHash: intentHash(built.intent),
    expiresAt: new Date(Number(deadline) * 1000).toISOString(),
    expiresInSec: Math.max(0, Math.floor(Number(deadline) - Date.now() / 1000)),
    fromAddress,
    toAddress,
    checks: { balance: "not_checked", recipient },
    ...prepared,
  };
}

function resolveSide(
  catalog: SwapCatalog,
  chain: string,
  token: string,
  side: "from" | "to",
): { chain: ChainInfo; token: SwapsApiToken; config: SwapChain } {
  const resolution = resolveExactly(catalog, chain, token, `${side}Token`, side);
  if (!canUseAs(resolution.token, side)) {
    const { symbol } = resolution.token;
    throw new ActionError("RESTRICTED_TOKEN", `${symbol} on ${resolution.chain.name} can't be used on that side.`);
  }
  const config = catalog.chains[resolution.chain.key];
  if (!config) throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX chain config doesn't describe that chain.");
  // A recipient that can't hold the token would strand the swap's output, so an unchecked one isn't quoted.
  if (side === "to" && config.type === "STELLAR" && !stellarRecipientCheckable(resolution.token.address)) {
    const { symbol } = resolution.token;
    throw new ActionError("RESTRICTED_TOKEN", `This server can't check that a Stellar account can receive ${symbol}.`, {
      nextStep: `Tell the user a swap to ${symbol} on Stellar isn't available here for now, and ask whether they want another token.`,
      details: { side },
    });
  }
  // The amount is scaled by these decimals and the intent checked against this hub asset.
  const { decimals, hubAsset, address } = resolution.token;
  const packaged = packagedToken(resolution.chain.key, address);
  if (packaged && (packaged.decimals !== decimals || !same(packaged.hubAsset, hubAsset))) {
    throw configDisagrees(resolution.chain.key, `${side}Token`, address);
  }
  return { ...resolution, config };
}

function describe({ chain, token }: { chain: ChainInfo; token: SwapsApiToken }): Side {
  return { chain, symbol: token.symbol, address: token.address };
}

/** A token as an intent names it: a hub token (native S included) as is, else by its hub asset. */
const intentToken = (chainKey: string, token: SwapsApiToken) => (isHubChain(chainKey) ? token.address : token.hubAsset);

/** A value as a 32-byte ABI word (hex, no prefix). */
const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).toLowerCase().padStart(64, "0");

/** What the intent must hold besides the request: the tokens as quoted, the partner fee, the user's hub wallet. */
interface IntentWant {
  from: SwapsApiToken;
  to: SwapsApiToken;
  fee: bigint;
  hubWallet: string;
}

/**
 * The intent the Swaps API built must be the one quoted; names the first check that fails. Its JSON must say what
 * was asked (input net of the partner fee, minimum, deadline, chains, tokens, recipient and sender as the SDK
 * encodes them, fee envelope, no partial fill, any solver), be created by the user's own hub wallet, and come with
 * the relay payload the SDK builds for it, which is what the user's hub wallet runs.
 */
function findIntentMismatch(
  request: IntentRequest,
  source: SourceChain,
  want: IntentWant,
  built: BuiltIntent,
): string | undefined {
  const { intent, relayData } = built;
  const { partnerFee, srcChainKey } = request;
  // The fee envelope: `0x01`, the fee and the receiver, or `0x` without a fee.
  const feeData = partnerFee ? `0x01${word(want.fee)}${word(partnerFee.address)}` : "0x";
  const recipient = encodeRecipient(request.dstChainKey, request.dstAddress);
  const sender = encodeRecipient(srcChainKey, request.srcAddress);
  const payload = createIntentPayload(intent, isHubSource(source));
  const checks: [string, boolean][] = [
    ["inputAmount", intent.inputAmount === (request.inputAmount - want.fee).toString()],
    ["minOutputAmount", intent.minOutputAmount === request.minOutputAmount.toString()],
    ["deadline", intent.deadline === request.deadline],
    ["srcChain", intent.srcChain === intentChainId(srcChainKey)],
    ["dstChain", intent.dstChain === intentChainId(request.dstChainKey)],
    ["inputToken", same(intent.inputToken, intentToken(srcChainKey, want.from))],
    ["outputToken", same(intent.outputToken, intentToken(request.dstChainKey, want.to))],
    ["dstAddress", recipient !== undefined && same(intent.dstAddress, recipient)],
    ["srcAddress", sender !== undefined && same(intent.srcAddress, sender)],
    ["feeData", intent.data.toLowerCase() === feeData],
    ["allowPartialFill", intent.allowPartialFill === false],
    ["solver", ZERO_ADDRESS_PATTERN.test(intent.solver)],
    ["creator", same(intent.creator, want.hubWallet) && same(relayData.address, intent.creator)],
    ["relay payload", payload !== undefined && same(relayData.payload, payload)],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
}
