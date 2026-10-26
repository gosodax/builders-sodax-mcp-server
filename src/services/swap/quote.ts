/**
 * Quote a swap and, given the sender's address, build the transactions to sign.
 * Returns structure only; the tool words the next step.
 *
 * Nothing here signs, holds funds or submits anything: the user's wallet sends
 * the steps, and the cached quote is what tracking later submits.
 */

import { createHash } from "node:crypto";
import { EVM_ADDRESS_PATTERN, ZERO_ADDRESS_PATTERN } from "../../constants.js";
import { logger } from "../logger.js";
import type { PartnerFee } from "../partnerFee.js";
import { type LoadedSdk, getSdk } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import {
  type HubCall,
  type SignedIntent,
  type SpokeSwap,
  decodeApprove,
  decodeCreateIntent,
  decodeSpokeSwap,
} from "./calldata.js";
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

  const sdk = getSdk();
  // A native HBAR deposit needs Hedera's msg.value scaling, which the SDK doesn't export yet: until it
  // does, the built value can't be checked, so only a price is given.
  if (from.chain.key === sdk.hederaChainKey && from.token.isNative) {
    throw new ActionError(
      "UNSUPPORTED_SOURCE",
      `This server can only price swaps of native ${from.token.symbol} for now.`,
      {
        nextStep: `Tell the user a swap of native ${from.token.symbol} can be priced but not prepared here yet.`,
      },
    );
  }
  const hub = from.chain.key === sdk.hubChainKey;
  const swapContract = pinnedSwapContract(from.chain.key, from.config.swapContract, hub);
  if (!swapContract) {
    throw new ActionError(
      "UPSTREAM_UNAVAILABLE",
      "The SODAX config doesn't agree on the source chain's swap contract.",
    );
  }

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
  // A native token needs no approval.
  const [built, approved] = await Promise.all([buildIntent(request), from.token.isNative || checkAllowance(request)]);
  const approval = approved ? undefined : await buildApprove(request);
  const mismatch = findMismatch(
    request,
    { from: from.token, to: to.token, fee, swapContract, hub, intentsContract: sdk.intentsContract },
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

/** The SDK encodes a recipient the way intents carry it, and refuses one that isn't valid for its chain (EIP-55 included). */
function encodeAddress(chainKey: string, address: string): string | undefined {
  try {
    // Catalog chain keys are the SDK's chain keys; an unknown one throws like a bad address.
    return getSdk().encodeAddress(chainKey as Parameters<LoadedSdk["encodeAddress"]>[0], address);
  } catch {
    return undefined;
  }
}

// An all-zero address in any family (EVM `0x0…0`, Sui `0x0`, Solana's system program) burns what it receives.
function checkAddress(address: string, chain: ChainInfo): string {
  const encoded = encodeAddress(chain.key, address);
  if (!encoded || /^0x0*$/.test(encoded)) {
    throw new ActionError("INVALID_ADDRESS", `That isn't a valid address on ${chain.name}.`);
  }
  return address;
}

/**
 * The contract a swap from this chain must call, from the SDK's packaged config: the hub intents
 * contract from the hub, else the spoke's asset manager. The live chain config must agree.
 */
function pinnedSwapContract(chainKey: string, live: string | undefined, hub: boolean): string | undefined {
  const { spokeChainConfig, intentsContract } = getSdk();
  // Read loosely: the hub's entry has no asset manager, and the key comes from the catalog.
  const addresses: unknown = (spokeChainConfig as Record<string, { addresses?: unknown } | undefined>)[chainKey]
    ?.addresses;
  const assetManager =
    addresses && typeof addresses === "object" ? (addresses as { assetManager?: unknown }).assetManager : undefined;
  const packaged = hub ? intentsContract : assetManager;
  if (typeof packaged !== "string" || !EVM_ADDRESS_PATTERN.test(packaged)) return undefined;
  if (live && !same(live, packaged)) {
    logger.error({ chainKey }, "The live chain config's asset manager differs from the SDK's");
    return undefined;
  }
  return packaged;
}

const HEX = /^0x[0-9a-fA-F]+$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** A value as a 32-byte ABI word (hex, no prefix). */
const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).toLowerCase().padStart(64, "0");

const INTENT_FIELDS = [
  "intentId",
  "creator",
  "inputToken",
  "outputToken",
  "inputAmount",
  "minOutputAmount",
  "deadline",
  "allowPartialFill",
  "srcChain",
  "dstChain",
  "srcAddress",
  "dstAddress",
  "solver",
  "data",
] as const;

/**
 * The Swaps API builds what the user signs, so check it is the swap that was quoted, and name the
 * first check that fails. The intent JSON must say what was asked (input net of the partner fee,
 * minimum, deadline, hub tokens, recipient as the SDK encodes it, sender, fee envelope, no partial
 * fill, any solver). The signed tx, decoded by ABI position, must carry exactly that, to the
 * contracts the SDK config pins:
 * - from a spoke, `transfer` on its asset manager of the source token and the gross amount to the
 *   intent's hub wallet, whose call list (the relay payload track submits) approves exactly the
 *   gross amount of the hub asset to the hub intents contract, then calls `createIntent` on it;
 * - from the hub, `createIntent` on the hub intents contract itself (the relay payload is the tx data);
 * and that `createIntent` must hold every field of the JSON intent. Any approval on the source chain
 * must be `approve(the swap contract, exact amount)`.
 */
function findMismatch(
  request: IntentRequest,
  want: {
    from: SwapsApiToken;
    to: SwapsApiToken;
    fee: bigint;
    /** The contract the swap tx calls: the spoke's asset manager, or the intents contract from the hub. */
    swapContract: string;
    hub: boolean;
    intentsContract: string;
  },
  built: BuiltIntent,
  approval?: Approval,
): string | undefined {
  const { intent, tx, relayData } = built;
  const { partnerFee } = request;
  // The fee envelope: `0x01`, the fee and the receiver, or `0x` without a fee.
  const feeData = partnerFee ? `0x01${word(want.fee)}${word(partnerFee.address)}` : "0x";
  const recipient = encodeAddress(request.dstChainKey, request.dstAddress);

  let spoke: SpokeSwap | undefined;
  let signedIntent: SignedIntent | undefined;
  try {
    if (want.hub) {
      signedIntent = decodeCreateIntent(tx.data);
    } else {
      spoke = decodeSpokeSwap(tx.data);
      const last = spoke.calls.at(-1);
      signedIntent = last && decodeCreateIntent(last.data);
    }
  } catch {
    // Malformed calldata: the checks below fail on the missing values.
  }
  const hubCalls = spoke?.calls ?? [];
  const hubApproves = (call: HubCall) => {
    try {
      const { spender, amount } = decodeApprove(call.data);
      return same(call.to, intent.inputToken) && same(spender, want.intentsContract) && amount === request.inputAmount;
    } catch {
      return false;
    }
  };
  const sourceApproves = (step: EvmTx, amount: bigint) => {
    try {
      const decoded = decodeApprove(step.data);
      return (
        same(step.from, request.srcAddress) &&
        same(step.to, request.inputToken) &&
        BigInt(step.value) === 0n &&
        step.data.length === 138 &&
        same(decoded.spender, want.swapContract) &&
        decoded.amount === amount
      );
    } catch {
      return false;
    }
  };

  const checks: [string, boolean][] = [
    ["inputAmount", intent.inputAmount === (request.inputAmount - want.fee).toString()],
    ["minOutputAmount", intent.minOutputAmount === request.minOutputAmount.toString()],
    ["deadline", intent.deadline === request.deadline],
    ["inputToken", same(intent.inputToken, want.from.hubAsset)],
    ["outputToken", same(intent.outputToken, want.to.hubAsset)],
    ["dstAddress", recipient !== undefined && same(intent.dstAddress, recipient)],
    ["srcAddress", same(intent.srcAddress, request.srcAddress)],
    ["feeData", intent.data.toLowerCase() === feeData],
    ["allowPartialFill", intent.allowPartialFill === false],
    ["solver", ZERO_ADDRESS_PATTERN.test(intent.solver)],
    ["tx.from", same(tx.from, request.srcAddress)],
    ["tx.to", same(tx.to, want.swapContract)],
    ["tx.value", BigInt(tx.value) === (want.from.isNative ? request.inputAmount : 0n)],
    ["tx.data", want.hub ? signedIntent !== undefined : spoke !== undefined],
    ["transfer token", want.hub || (spoke !== undefined && same(spoke.token, request.inputToken))],
    ["transfer amount", want.hub || spoke?.amount === request.inputAmount],
    [
      "hub wallet",
      same(relayData.address, intent.creator) && (want.hub || (spoke !== undefined && same(spoke.to, intent.creator))),
    ],
    ["relay payload", same(want.hub ? tx.data : (spoke?.payload ?? ""), relayData.payload)],
    [
      "hub calls",
      want.hub ||
        (same(hubCalls.at(-1)?.to ?? "", want.intentsContract) &&
          hubCalls.every(call => call.value === 0n) &&
          hubCalls.slice(0, -1).every(hubApproves)),
    ],
    [
      "signed intent",
      signedIntent !== undefined &&
        INTENT_FIELDS.every(field => String(signedIntent[field]).toLowerCase() === String(intent[field]).toLowerCase()),
    ],
    [
      "approval",
      !approval ||
        (sourceApproves(approval.tx, request.inputAmount) &&
          (!approval.resetTx || sourceApproves(approval.resetTx, 0n))),
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
