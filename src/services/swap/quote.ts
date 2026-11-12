/**
 * Quote a swap and, given the sender's address, build the transactions to sign.
 * Returns structure only; the tool words the next step.
 *
 * Nothing here signs, holds funds or submits anything: the user's wallet sends
 * the steps, and the cached quote is what tracking later submits.
 */

import { createHash } from "node:crypto";
import { ZERO_ADDRESS_PATTERN, sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import type { PartnerFee } from "../partnerFee.js";
import { callerKeyHash } from "../requestContext.js";
import {
  type SwapTx,
  approveCalldata,
  buildNonEvmDeposit,
  callsPinnedTarget,
  createIntentPayload,
  encodeRecipient,
  intentChainId,
  intentHash,
  isHubChain,
  packagedToken,
  rebuildSwapTx,
  stellarRecipientCheckable,
  userHubWallet,
} from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { type RecipientCheck, checkRecipient } from "./destination.js";
import { ActionError } from "./errors.js";
import { type NonEvmStep, toNonEvmStep } from "./nonEvmSource.js";
import { checkQuoteRoom, putQuote } from "./quoteCache.js";
import { checkAddress, resolveExactly } from "./resolver.js";
import {
  type EvmSource,
  type NonEvmSource,
  type SourceChain,
  configDisagrees,
  isHubSource,
  readBlockNumber,
  sourceChainFor,
} from "./source.js";
import {
  type Approval,
  type BuiltIntent,
  type EvmTx,
  type IntentRequest,
  asEvmTx,
  buildApprove,
  buildIntent,
  checkAllowance,
  getDeadline,
  getQuote,
  leavesTimeToSend,
  parseEvmTx,
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

/** A step an EVM wallet sends; a non-EVM spoke's swap is a `NonEvmStep`. */
export interface EvmStep {
  kind: "reset_approve" | "approve" | "swap";
  chainId: number;
  tx: StepTx;
}
export type SwapStep = EvmStep | NonEvmStep;

/** `value` and `chainId` are hex quantities. */
export type StepTx = EvmTx & { chainId: string };

/**
 * EIP-5792 `wallet_sendCalls`, for wallets that batch: it replaces the steps it lists. Its `calls` are
 * those steps' `{to, value, data}` in order, left to the agent so the calldata isn't returned twice.
 */
export interface SwapBatch {
  replaces: EvmStep["kind"][];
  method: "wallet_sendCalls";
  params: [{ version: "2.0.0"; chainId: string; from: string; atomicRequired: true }];
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
  if (source.family === "EVM" && from.config.chainId !== source.chainId) {
    throw configDisagrees(from.chain.key, "chainId");
  }
  // An EVM sender's address is theirs on an EVM destination too; any other pair needs the recipient given.
  const defaultsToSender = to.config.type === "EVM" && source.family === "EVM";

  const amount = parseUnits(input.amount, from.token.decimals);
  const fromAddress = input.fromAddress ? checkAddress(input.fromAddress, from.chain, "fromAddress") : undefined;
  // The recipient defaults to the sender between EVM chains.
  const toAddress = input.toAddress
    ? checkAddress(input.toAddress, to.chain, "toAddress")
    : defaultsToSender
      ? fromAddress
      : undefined;
  const ready = fromAddress !== undefined && toAddress !== undefined;
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
    // A dead source RPC fails the quote before any steps, not the track after the user has sent them. A
    // non-EVM swap tx is built here, which reads its chain, except NEAR's.
    ready && (source.family === "EVM" || source.family === "NEAR") ? readBlockNumber(from.chain) : undefined,
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
  const prepared =
    source.family === "EVM"
      ? await prepareEvmSwap(request, source, want, built, approved)
      : await prepareNonEvmSwap(request, source, from.chain, from.token.symbol, built, approved);
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

/**
 * The EVM steps: the Swaps API's swap tx (and any approval) checked byte for byte against the SDK's rebuild, as
 * `findEvmTxMismatch` says, then the approve and swap as one batch.
 */
async function prepareEvmSwap(
  request: IntentRequest,
  source: EvmSource,
  want: IntentWant,
  built: BuiltIntent,
  approved: boolean,
): Promise<{ steps: SwapStep[]; batch?: SwapBatch }> {
  const tx = parseEvmTx(built.tx);
  const approval = approved ? undefined : await buildApprove(request);
  const expected = await rebuildSwapTx({
    srcChainKey: request.srcChainKey,
    srcAddress: request.srcAddress,
    token: request.inputToken,
    amount: request.inputAmount,
    intent: built.intent,
  });
  const mismatch = findEvmTxMismatch(request, source.swapContract, expected, tx, approval);
  if (mismatch) throw swapMismatch(request, mismatch, tx);
  return toSteps(tx, approval, source.chainId, request.srcAddress);
}

/**
 * A non-EVM spoke's step: the SDK builds the deposit here from the checked intent and payload, as its own swaps
 * do. The Swaps API's tx isn't used: blockhash, sequence and fees make it differ from any rebuild, so it couldn't
 * be checked byte for byte. A Stellar source the SDK says needs more trustline room is refused: no changeTrust step.
 */
async function prepareNonEvmSwap(
  request: IntentRequest,
  source: NonEvmSource,
  chain: ChainInfo,
  symbol: string,
  built: BuiltIntent,
  approved: boolean,
): Promise<{ steps: SwapStep[] }> {
  // Only Stellar has an approval of its own: trustline room. The swap service says no other family needs one.
  if (!approved && source.family === "STELLAR") {
    throw new ActionError("SWAP_REJECTED", `The wallet's ${symbol} trustline has too little room for this amount.`, {
      nextStep: `Tell the user their Stellar wallet must raise its ${symbol} trustline limit by the amount sent, then quote again.`,
    });
  }
  if (!approved) {
    throw new ActionError(
      "SWAP_REJECTED",
      `The swap service says ${symbol} on ${chain.name} needs an approval this server can't build.`,
      { nextStep: `Tell the user a swap of ${symbol} from ${chain.name} isn't available here for now.` },
    );
  }
  // The SDK reads the chain to build it, and a wallet it can't build for (no account, too little for fees) fails
  // the same way as an outage: the swap service built it a moment ago, so a retry is more likely to help.
  const raw = await buildNonEvmDeposit({
    srcChainKey: request.srcChainKey,
    srcAddress: request.srcAddress,
    token: request.inputToken,
    amount: request.inputAmount,
    to: built.intent.creator,
    payload: built.relayData.payload,
  }).catch(() => {
    throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't prepare the swap on ${chain.name} right now.`, {
      nextStep: `Retry in a minute. If it still fails, ask the user to check their ${chain.name} wallet holds the amount plus fees and has sent a transaction before, then quote again.`,
    });
  });
  const apiTo = (built.tx as { to?: unknown } | null)?.to;
  // The SDK reads Solana's programs and Sui's package from the chain: a wrong one is this server's RPC, not the API.
  if (!callsPinnedTarget(request.srcChainKey, "swap", raw, apiTo)) {
    logger.error({ "chain.key": request.srcChainKey }, "The SDK built a swap to another program than expected");
    throw new ActionError("SWAP_MISMATCH", "The swap built here calls another program than expected.", {
      details: { chainKey: request.srcChainKey },
    });
  }
  return { steps: [toNonEvmStep("swap", source.family, request.srcChainKey, raw)] };
}

/** Possibly a compromised or broken upstream: enough to investigate, no user addresses. */
function swapMismatch(request: IntentRequest, mismatch: string, builtTx: unknown): ActionError {
  const { srcChainKey, dstChainKey } = request;
  const tx = asEvmTx(builtTx);
  const dataSha256 = tx && createHash("sha256").update(tx.data.toLowerCase()).digest("hex");
  logger.error(
    {
      mismatch,
      "chain.key": srcChainKey,
      "dst_chain.key": dstChainKey,
      ...(tx && { "tx.to": tx.to, "tx.data_sha256": dataSha256 }),
    },
    "The Swaps API built a swap that doesn't match the quote",
  );
  return new ActionError("SWAP_MISMATCH", "The swap service built a different swap than the one quoted.", {
    details: { chainKey: srcChainKey },
  });
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

/**
 * The EVM swap tx must be, byte for byte, the one the SDK builds for the checked intent, and any approval
 * `approve(the pinned swap contract, exact amount)` on the source token. Names the first check that fails.
 */
function findEvmTxMismatch(
  request: IntentRequest,
  /** The contract the swap calls: the spoke's asset manager, or the hub's intents contract. */
  swapContract: string,
  /** The SDK's rebuild of the swap tx, if it could. */
  expected: SwapTx | undefined,
  tx: EvmTx,
  approval?: Approval,
): string | undefined {
  const approves = (step: EvmTx, amount: bigint) =>
    same(step.from, request.srcAddress) &&
    same(step.to, request.inputToken) &&
    BigInt(step.value) === 0n &&
    same(step.data, approveCalldata(request.inputToken, swapContract, amount));
  const checks: [string, boolean][] = [
    ["tx.from", same(tx.from, request.srcAddress)],
    ["rebuild", expected !== undefined],
    ["tx.to", same(tx.to, expected?.to ?? "")],
    ["tx.value", BigInt(tx.value) === expected?.value],
    ["tx.data", same(tx.data, expected?.data ?? "")],
    [
      "approval",
      !approval ||
        (approves(approval.tx, request.inputAmount) && (!approval.resetTx || approves(approval.resetTx, 0n))),
    ],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
}

/**
 * Hex quantities, as `eth_sendTransaction` takes them. The chain id is in the tx: several chains share the
 * contracts a step calls, so a wallet on another network must refuse it rather than send it there.
 */
export function toStepTx(tx: EvmTx, chainId: number): StepTx {
  return { ...tx, value: `0x${BigInt(tx.value).toString(16)}`, chainId: `0x${chainId.toString(16)}` };
}

/** The steps in order and, with an approval, the approve and swap as one batch. A reset stays out: it must land first. */
function toSteps(
  swapTx: EvmTx,
  approval: Approval | undefined,
  chainId: number,
  from: string,
): { steps: SwapStep[]; batch?: SwapBatch } {
  const swap: SwapStep = { kind: "swap", chainId, tx: toStepTx(swapTx, chainId) };
  if (!approval) return { steps: [swap] };
  const approve: SwapStep = { kind: "approve", chainId, tx: toStepTx(approval.tx, chainId) };
  const reset: SwapStep[] = approval.resetTx
    ? [{ kind: "reset_approve", chainId, tx: toStepTx(approval.resetTx, chainId) }]
    : [];
  return {
    steps: [...reset, approve, swap],
    batch: {
      replaces: ["approve", "swap"],
      method: "wallet_sendCalls",
      params: [
        {
          version: "2.0.0",
          chainId: `0x${chainId.toString(16)}`,
          from,
          atomicRequired: true,
        },
      ],
    },
  };
}
