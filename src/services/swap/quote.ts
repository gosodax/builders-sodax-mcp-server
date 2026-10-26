/**
 * Quote a swap and, given the sender's address, build the transactions to sign.
 * Returns structure only; the tool words the next step.
 *
 * Nothing here signs, holds funds or submits anything: the user's wallet sends
 * the steps, and the cached quote is what tracking later submits.
 */

import { EVM_ADDRESS_PATTERN } from "../../constants.js";
import { logger } from "../logger.js";
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
  // Without a known contract to send to (Sonic, for now) the built swap can't be checked, so it's refused.
  const { chainId, swapContract } = from.config;
  if (from.config.type !== "EVM" || typeof chainId !== "number" || !swapContract) {
    throw new ActionError("UNSUPPORTED_SOURCE", `Swaps from ${from.chain.name} aren't supported here yet.`);
  }
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
  const mismatch = findMismatch(
    request,
    { ...expected(from.token, to.token, fee, partnerFee), swapContract },
    built,
    approval,
  );
  if (mismatch) {
    logger.error(
      { mismatch, srcChainKey: request.srcChainKey },
      "The Swaps API built a swap that doesn't match the quote",
    );
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The swap service built a different swap than the one quoted.", {
      nextStep: "Tell the user this swap couldn't be prepared safely, and don't retry it.",
    });
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
  const valid = evm ? EVM_ADDRESS_PATTERN.test(address) && !ZERO_ADDRESS.test(address) : ANY_ADDRESS.test(address);
  if (!valid) {
    throw new ActionError("INVALID_ADDRESS", `That isn't a valid address on ${chain.name}.`);
  }
  return address;
}

const APPROVE_SELECTOR = "0x095ea7b3";
const ZERO_ADDRESS = /^0x0{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** A value as a 32-byte ABI word (hex, no prefix). */
const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).toLowerCase().padStart(64, "0");

interface Expected {
  /** Hub assets of the tokens sent and received. */
  inputHubAsset: string;
  outputHubAsset: string;
  isNative: boolean;
  fee: bigint;
  /** The intent's fee envelope: `0x01`, the fee and the receiver, or `0x` without a fee. */
  feeData: string;
  swapContract: string;
}

function expected(from: SwapsApiToken, to: SwapsApiToken, fee: bigint, partnerFee?: PartnerFee) {
  return {
    inputHubAsset: from.hubAsset,
    outputHubAsset: to.hubAsset,
    isNative: from.isNative,
    fee,
    feeData: partnerFee ? `0x01${word(fee)}${word(partnerFee.address)}` : "0x",
  };
}

/**
 * The Swaps API builds what the user signs, so check it is the swap that was quoted, and name
 * the first check that fails. The intent JSON must say what was asked (input net of the partner
 * fee, minimum, deadline, hub tokens, recipient, sender, fee envelope, no partial fill, any
 * solver), and the signed tx must carry it: sent to the chain's known contract, with the right
 * value, and its data holding the relay payload track submits and each of those fields as an ABI
 * word. That ties the JSON to the bytes without a full decode. An approval must be
 * `approve(that contract, exact amount)` on the source token. A non-hex recipient (base58,
 * names) is encoded per chain, so only a hex one is compared with what was asked.
 */
function findMismatch(
  request: IntentRequest,
  want: Expected,
  built: BuiltIntent,
  approval?: Approval,
): string | undefined {
  const { intent, tx, relayData } = built;
  const data = tx.data.toLowerCase();
  const carries = (value: string) => HEX.test(value) && data.includes(value.slice(2).toLowerCase());
  const approves = (step: EvmTx, amount: bigint) =>
    same(step.from, request.srcAddress) &&
    same(step.to, request.inputToken) &&
    BigInt(step.value) === 0n &&
    step.data.length === 138 &&
    step.data.slice(0, 10) === APPROVE_SELECTOR &&
    step.data.slice(10, 74).toLowerCase() === word(want.swapContract) &&
    BigInt(`0x${step.data.slice(74)}`) === amount;
  const checks: [string, boolean][] = [
    ["inputAmount", intent.inputAmount === (request.inputAmount - want.fee).toString()],
    ["minOutputAmount", intent.minOutputAmount === request.minOutputAmount.toString()],
    ["deadline", intent.deadline === request.deadline],
    ["inputToken", same(intent.inputToken, want.inputHubAsset)],
    ["outputToken", same(intent.outputToken, want.outputHubAsset)],
    // Compared as numbers: a short Sui address comes back padded to 32 bytes.
    [
      "dstAddress",
      HEX.test(intent.dstAddress) &&
        (!HEX.test(request.dstAddress) || BigInt(intent.dstAddress) === BigInt(request.dstAddress)),
    ],
    ["srcAddress", same(intent.srcAddress, request.srcAddress)],
    ["feeData", intent.data.toLowerCase() === want.feeData],
    ["allowPartialFill", intent.allowPartialFill === false],
    ["solver", ZERO_ADDRESS.test(intent.solver)],
    ["tx.from", same(tx.from, request.srcAddress)],
    ["tx.to", same(tx.to, want.swapContract)],
    ["tx.value", BigInt(tx.value) === (want.isNative ? request.inputAmount : 0n)],
    ["tx.data payload", carries(relayData.payload)],
    [
      "tx.data fields",
      [
        word(BigInt(intent.inputAmount)),
        word(request.minOutputAmount),
        word(BigInt(request.deadline)),
        word(intent.inputToken),
        word(intent.outputToken),
      ].every(field => data.includes(field)) && carries(intent.dstAddress),
    ],
    [
      "approval",
      !approval ||
        (approves(approval.tx, request.inputAmount) && (!approval.resetTx || approves(approval.resetTx, 0n))),
    ],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
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
