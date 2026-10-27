/**
 * Quote a swap and, given the sender's address, build the transactions to sign.
 * Returns structure only; the tool words the next step.
 *
 * Nothing here signs, holds funds or submits anything: the user's wallet sends
 * the steps, and the cached quote is what tracking later submits.
 */

import { createHash } from "node:crypto";
import { ZERO_ADDRESS_PATTERN } from "../../constants.js";
import { logger } from "../logger.js";
import type { PartnerFee } from "../partnerFee.js";
import {
  type SwapTx,
  approveCalldata,
  encodeRecipient,
  evmChainIdFor,
  intentChainId,
  isHubChain,
  packagedToken,
  rebuildSwapTx,
  swapContractFor,
  userHubWallet,
} from "../sodax.js";
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
  leavesTimeToSend,
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

export async function quoteSwap(input: QuoteInput, partnerFee?: PartnerFee): Promise<SwapQuote> {
  const catalog = await getSwapCatalog();
  const from = resolveSide(catalog, input.fromChain, input.fromToken, "from");
  const to = resolveSide(catalog, input.toChain, input.toToken, "to");
  // The catalog only keeps an EVM chain with a numeric id; the typeof narrows it for TypeScript.
  const { chainId } = from.config;
  if (from.config.type !== "EVM" || typeof chainId !== "number") {
    throw new ActionError("UNSUPPORTED_SOURCE", `Swaps from ${from.chain.name} aren't supported here yet.`);
  }
  const dstEvm = to.config.type === "EVM";

  const amount = parseUnits(input.amount, from.token.decimals);
  const fromAddress = input.fromAddress ? checkAddress(input.fromAddress, from.chain) : undefined;
  // An EVM recipient defaults to the sender.
  const toAddress = input.toAddress ? checkAddress(input.toAddress, to.chain) : dstEvm ? fromAddress : undefined;
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

  // Pinned from the packaged config; the live chain config must agree with it. Five EVM chains
  // share one asset manager, so the chain id is pinned too.
  const swapContract = swapContractFor(from.chain.key);
  const live = from.config.swapContract;
  if (!swapContract || (live && !same(live, swapContract))) throw configDisagrees(from.chain.key, "swapContract");
  const pinnedChainId = evmChainIdFor(from.chain.key);
  if (pinnedChainId !== chainId) throw configDisagrees(from.chain.key, "chainId");

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
  const approval = approved ? undefined : await buildApprove(request);
  const expected = await rebuildSwapTx({
    srcChainKey: request.srcChainKey,
    srcAddress: fromAddress,
    token: request.inputToken,
    amount,
    intent: built.intent,
  });
  const mismatch = findMismatch(
    request,
    { from: from.token, to: to.token, fee, swapContract, hubWallet, expected },
    built,
    approval,
  );
  if (mismatch) {
    // Possibly a compromised or broken upstream: enough to investigate, no user addresses.
    const { srcChainKey, dstChainKey } = request;
    const dataSha256 = createHash("sha256").update(built.tx.data.toLowerCase()).digest("hex");
    logger.error(
      { mismatch, srcChainKey, dstChainKey, txTo: built.tx.to, dataSha256 },
      "The Swaps API built a swap that doesn't match the quote",
    );
    throw new ActionError("SWAP_MISMATCH", "The swap service built a different swap than the one quoted.");
  }
  // The builds above can take most of a minute, which a short deadline can't spare.
  if (!leavesTimeToSend(deadline)) {
    throw new ActionError("DEADLINE_TOO_SHORT", "Preparing the swap left too little time to send it.");
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
    ...toSteps(built.tx, approval, pinnedChainId, fromAddress),
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
  // The amount is scaled by these decimals and the intent checked against this hub asset.
  const { decimals, hubAsset, address } = resolution.token;
  const packaged = packagedToken(resolution.chain.key, address);
  if (packaged && (packaged.decimals !== decimals || !same(packaged.hubAsset, hubAsset))) {
    throw configDisagrees(resolution.chain.key, `${side}Token`);
  }
  return { ...resolution, config };
}

/** The live config disagrees with the SDK's packaged one: a broken or compromised upstream. */
function configDisagrees(chainKey: string, field: string): ActionError {
  logger.error({ chainKey, field }, "The live SODAX config differs from the SDK's");
  return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX config doesn't agree with the SDK's.");
}

function describe({ chain, token }: { chain: ChainInfo; token: SwapsApiToken }): Side {
  return { chain, symbol: token.symbol, address: token.address };
}

// An all-zero address in any family (EVM `0x0…0`, Sui `0x0`, Solana's system program) burns what it receives.
function checkAddress(address: string, chain: ChainInfo): string {
  const encoded = encodeRecipient(chain.key, address);
  if (!encoded || /^0x0*$/.test(encoded)) {
    throw new ActionError("INVALID_ADDRESS", `That isn't a valid address on ${chain.name}.`);
  }
  return address;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** A token as an intent names it: a hub token (native S included) as is, else by its hub asset. */
const intentToken = (chainKey: string, token: SwapsApiToken) => (isHubChain(chainKey) ? token.address : token.hubAsset);
/** A value as a 32-byte ABI word (hex, no prefix). */
const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).toLowerCase().padStart(64, "0");

/**
 * The Swaps API builds what the user signs, so check it is the swap that was quoted, and name the
 * first check that fails. The intent JSON must say what was asked (input net of the partner fee,
 * minimum, deadline, chains, tokens, recipient as the SDK encodes it, sender, fee envelope, no
 * partial fill, any solver) and be created by the user's own hub wallet. The swap tx must then be,
 * byte for byte, the one the SDK builds for that intent (the relay payload included), and any
 * approval `approve(the pinned swap contract, exact amount)` on the source token.
 */
function findMismatch(
  request: IntentRequest,
  want: {
    from: SwapsApiToken;
    to: SwapsApiToken;
    fee: bigint;
    /** The contract the swap calls: the spoke's asset manager, or the intents contract from the hub. */
    swapContract: string;
    hubWallet: string;
    /** The SDK's rebuild of the swap tx, if it could. */
    expected?: SwapTx;
  },
  built: BuiltIntent,
  approval?: Approval,
): string | undefined {
  const { intent, tx, relayData } = built;
  const { partnerFee, expected } = { ...request, ...want };
  // The fee envelope: `0x01`, the fee and the receiver, or `0x` without a fee.
  const feeData = partnerFee ? `0x01${word(want.fee)}${word(partnerFee.address)}` : "0x";
  const recipient = encodeRecipient(request.dstChainKey, request.dstAddress);
  const approves = (step: EvmTx, amount: bigint) =>
    same(step.from, request.srcAddress) &&
    same(step.to, request.inputToken) &&
    BigInt(step.value) === 0n &&
    same(step.data, approveCalldata(request.inputToken, want.swapContract, amount));

  const checks: [string, boolean][] = [
    ["inputAmount", intent.inputAmount === (request.inputAmount - want.fee).toString()],
    ["minOutputAmount", intent.minOutputAmount === request.minOutputAmount.toString()],
    ["deadline", intent.deadline === request.deadline],
    ["srcChain", intent.srcChain === intentChainId(request.srcChainKey)],
    ["dstChain", intent.dstChain === intentChainId(request.dstChainKey)],
    ["inputToken", same(intent.inputToken, intentToken(request.srcChainKey, want.from))],
    ["outputToken", same(intent.outputToken, intentToken(request.dstChainKey, want.to))],
    ["dstAddress", recipient !== undefined && same(intent.dstAddress, recipient)],
    ["srcAddress", same(intent.srcAddress, request.srcAddress)],
    ["feeData", intent.data.toLowerCase() === feeData],
    ["allowPartialFill", intent.allowPartialFill === false],
    ["solver", ZERO_ADDRESS_PATTERN.test(intent.solver)],
    ["creator", same(intent.creator, want.hubWallet) && same(relayData.address, intent.creator)],
    ["tx.from", same(tx.from, request.srcAddress)],
    ["rebuild", expected !== undefined],
    ["tx.to", same(tx.to, expected?.to ?? "")],
    ["tx.value", BigInt(tx.value) === expected?.value],
    ["tx.data", same(tx.data, expected?.data ?? "")],
    ["relay payload", same(relayData.payload, expected?.payload ?? "")],
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
