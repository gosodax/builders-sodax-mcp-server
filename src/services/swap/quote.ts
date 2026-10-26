/**
 * Quote a swap and, given the sender's address, build the transactions to sign.
 * Returns structure only; the tool words the next step.
 *
 * Nothing here signs, holds funds or submits anything: the user's wallet sends
 * the steps, and the cached quote is what tracking later submits.
 */

import { EVM_ADDRESS_PATTERN } from "../../constants.js";
import type { PartnerFee } from "../partnerFee.js";
import type { ChainInfo } from "../sodaxApi.js";
import { type RecipientCheck, checkRecipient } from "./destination.js";
import { ActionError } from "./errors.js";
import { putQuote } from "./quoteCache.js";
import { resolveToken } from "./resolver.js";
import {
  type Approval,
  type BuiltIntent,
  type EvmTx,
  type IntentRequest,
  buildApprove,
  buildIntent,
  checkAllowance,
  getDeadline,
  getQuote,
} from "./swapsApi.js";
import { type SwapCatalog, type SwapChain, type SwapsApiToken, canUseAs, getSwapCatalog } from "./tokens.js";
import { formatUnits, parseUnits } from "./units.js";

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
}

export interface SwapStep {
  kind: "reset_approve" | "approve" | "swap";
  chainId: number;
  /** `value` is a hex quantity. */
  tx: EvmTx;
}

/** EIP-5792 `wallet_sendCalls`, for wallets that batch: it replaces the steps it lists. */
export interface SwapBatch {
  replaces: SwapStep["kind"][];
  method: "wallet_sendCalls";
  params: [
    {
      version: "2.0.0";
      chainId: string;
      from: string;
      atomicRequired: true;
      calls: { to: string; value: string; data: string }[];
    },
  ];
}

export type SwapQuote =
  | (QuoteSummary & { status: "price_only"; missing: ("fromAddress" | "toAddress")[] })
  | (QuoteSummary & {
      status: "ready";
      quoteId: string;
      /** ISO time; the swap step must be mined before it. */
      expiresAt: string;
      fromAddress: string;
      toAddress: string;
      checks: { balance: "not_checked"; recipient: RecipientCheck };
      steps: SwapStep[];
      batch?: SwapBatch;
    });

// Other families (Solana, Sui, NEAR, …) are checked by the Swaps API; this only keeps junk out of the output.
const ANY_ADDRESS = /^[A-Za-z0-9:._-]{1,128}$/;

export async function quoteSwap(input: QuoteInput, partnerFee?: PartnerFee): Promise<SwapQuote> {
  const catalog = await getSwapCatalog();
  const from = resolveSide(catalog, input.fromChain, input.fromToken, "from");
  const to = resolveSide(catalog, input.toChain, input.toToken, "to");
  // The catalog only keeps an EVM chain with a numeric id; the typeof narrows it for TypeScript.
  if (from.config.type !== "EVM" || typeof from.config.chainId !== "number") {
    throw new ActionError("UNSUPPORTED_SOURCE", `Swaps from ${from.chain.name} aren't supported here yet.`);
  }
  const chainId = from.config.chainId;
  const dstEvm = to.config.type === "EVM";

  const amount = parseUnits(input.amount, from.token.decimals);
  const fromAddress = input.fromAddress ? checkAddress(input.fromAddress, true, from.chain) : undefined;
  // An EVM recipient defaults to the sender.
  const toAddress = input.toAddress
    ? checkAddress(input.toAddress, dstEvm, to.chain)
    : dstEvm
      ? fromAddress
      : undefined;
  const ready = fromAddress !== undefined && toAddress !== undefined;

  const [quoted, deadline] = await Promise.all([
    getQuote({
      tokenSrc: from.token.address,
      tokenSrcChainKey: from.chain.key,
      tokenDst: to.token.address,
      tokenDstChainKey: to.chain.key,
      amount,
      partnerFee,
    }),
    ready ? getDeadline(input.deadlineMinutes * 60) : undefined,
  ]);
  const minOutput = (quoted * BigInt(10_000 - input.slippageBps)) / 10_000n;
  if (minOutput === 0n) {
    throw new ActionError("AMOUNT_TOO_LOW", "The amount is too small: the minimum received would be zero.");
  }
  const fee = partnerFee ? (amount * BigInt(partnerFee.bps)) / 10_000n : 0n;

  const summary: QuoteSummary = {
    from: { ...describe(from), amount: formatUnits(amount, from.token.decimals) },
    to: {
      ...describe(to),
      expectedAmount: formatUnits(quoted, to.token.decimals),
      minimumAmount: formatUnits(minOutput, to.token.decimals),
    },
    slippageBps: input.slippageBps,
    ...(partnerFee && {
      partnerFee: { bps: partnerFee.bps, amount: formatUnits(fee, from.token.decimals), symbol: from.token.symbol },
    }),
  };

  if (!ready || deadline === undefined) {
    const missing: ("fromAddress" | "toAddress")[] = [];
    if (!fromAddress) missing.push("fromAddress");
    if (!toAddress && !dstEvm) missing.push("toAddress");
    return { status: "price_only", ...summary, missing };
  }

  const recipient = await checkRecipient(to.config.type);
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
  // A native token needs no approval.
  const [built, approved] = await Promise.all([buildIntent(request), from.token.isNative || checkAllowance(request)]);
  const approval = approved ? undefined : await buildApprove(request);
  if (!matchesQuote(request, { from: from.token, to: to.token, fee }, built, approval)) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The swap service built a different swap than the one quoted.");
  }

  const { quoteId } = putQuote({ ...request, intent: built.intent, relayData: built.relayData });
  return {
    status: "ready",
    ...summary,
    quoteId,
    expiresAt: new Date(Number(deadline) * 1000).toISOString(),
    fromAddress,
    toAddress,
    checks: { balance: "not_checked", recipient },
    ...toSteps(built.tx, approval, chainId, fromAddress),
  };
}

function resolveSide(
  catalog: SwapCatalog,
  chain: string,
  token: string,
  side: "from" | "to",
): { chain: ChainInfo; token: SwapsApiToken; config: SwapChain } {
  const resolution = resolveToken(catalog, chain, token);
  if (resolution.status !== "resolved") {
    throw new ActionError("UNKNOWN_TOKEN", `The ${side} token doesn't resolve to exactly one swap token.`, {
      details: { side },
    });
  }
  if (!canUseAs(resolution.token, side)) {
    const { symbol } = resolution.token;
    throw new ActionError("RESTRICTED_TOKEN", `${symbol} on ${resolution.chain.name} can't be used on that side.`);
  }
  const config = catalog.chains[resolution.chain.key];
  if (!config) throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX chain config doesn't describe that chain.");
  return { ...resolution, config };
}

function describe({ chain, token }: { chain: ChainInfo; token: SwapsApiToken }): Side {
  return { chain, symbol: token.symbol, address: token.address };
}

function checkAddress(address: string, evm: boolean, chain: ChainInfo): string {
  if (!(evm ? EVM_ADDRESS_PATTERN : ANY_ADDRESS).test(address)) {
    throw new ActionError("INVALID_ADDRESS", `That isn't a valid address on ${chain.name}.`);
  }
  return address;
}

const APPROVE_SELECTOR = "0x095ea7b3";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The Swaps API builds what the user signs, so check it is the swap that was quoted: amounts
 * (the intent's input is net of the partner fee, so this checks the fee shown), deadline,
 * tokens (as hub assets), recipient, sender and value, and that an approval is
 * `approve(swap target, exact amount)` on the source token. A non-hex recipient
 * (base58, names) is encoded per chain, so only a hex one is compared.
 */
function matchesQuote(
  request: IntentRequest,
  tokens: { from: SwapsApiToken; to: SwapsApiToken; fee: bigint },
  built: BuiltIntent,
  approval?: Approval,
): boolean {
  const { intent, tx } = built;
  const approves = (step: EvmTx, amount: bigint) =>
    same(step.from, request.srcAddress) &&
    same(step.to, request.inputToken) &&
    BigInt(step.value) === 0n &&
    step.data.length === 138 &&
    step.data.slice(0, 10) === APPROVE_SELECTOR &&
    same(`0x${step.data.slice(34, 74)}`, tx.to) &&
    BigInt(`0x${step.data.slice(74)}`) === amount;
  return (
    intent.inputAmount === (request.inputAmount - tokens.fee).toString() &&
    intent.minOutputAmount === request.minOutputAmount.toString() &&
    intent.deadline === request.deadline &&
    same(intent.inputToken, tokens.from.hubAsset) &&
    same(intent.outputToken, tokens.to.hubAsset) &&
    (!request.dstAddress.startsWith("0x") || same(intent.dstAddress, request.dstAddress)) &&
    same(tx.from, request.srcAddress) &&
    BigInt(tx.value) === (tokens.from.isNative ? request.inputAmount : 0n) &&
    (!approval || (approves(approval.tx, request.inputAmount) && (!approval.resetTx || approves(approval.resetTx, 0n))))
  );
}

/** Values as hex quantities, as `eth_sendTransaction` and `wallet_sendCalls` take them. */
function toStepTx(tx: EvmTx): EvmTx {
  return { ...tx, value: `0x${BigInt(tx.value).toString(16)}` };
}

/** The steps in order and, with an approval, the approve and swap as one batch. A reset stays out: it must land first. */
function toSteps(
  swapTx: EvmTx,
  approval: Approval | undefined,
  chainId: number,
  from: string,
): { steps: SwapStep[]; batch?: SwapBatch } {
  const swap: SwapStep = { kind: "swap", chainId, tx: toStepTx(swapTx) };
  if (!approval) return { steps: [swap] };
  const approve: SwapStep = { kind: "approve", chainId, tx: toStepTx(approval.tx) };
  const reset: SwapStep[] = approval.resetTx
    ? [{ kind: "reset_approve", chainId, tx: toStepTx(approval.resetTx) }]
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
          calls: [approve, swap].map(({ tx }) => ({ to: tx.to, value: tx.value, data: tx.data })),
        },
      ],
    },
  };
}
