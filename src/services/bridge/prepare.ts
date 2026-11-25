/**
 * `sodax_bridge_prepare`: a bridge checked end to end before anything is built (pair, addresses, recipient, limit),
 * built by the Bridge API and checked against the SDK's own build, then kept for submit and track. A bridge moves one
 * asset 1:1 through its hub vault, so there's no price to quote: what's received is the amount sent, less any partner
 * fee, in the received token's decimals.
 */

import { sameHex as same } from "../../constants.js";
import type { PartnerFee } from "../partnerFee.js";
import { bridgeAmounts, evmChainIdFor, isHubChain } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { checkRecipient } from "../swap/destination.js";
import { ActionError } from "../swap/errors.js";
import { checkAddress, resolveExactly } from "../swap/resolver.js";
import { sourceChainFor } from "../swap/source.js";
import { toStepTx } from "../swap/sources/evm.js";
import type { EvmStep, SwapStep } from "../swap/sources/types.js";
import type { EvmTx } from "../swap/swapsApi.js";
import type { SwapsApiToken } from "../swap/tokens.js";
import { formatUnits, parseUnits } from "../swap/units.js";
import type { BridgeRequest } from "./bridgeApi.js";
import { buildEvmBridge, buildNonEvmBridge } from "./build.js";
import { getBridgeCatalog } from "./catalog.js";
import { type BridgeSide, checkBridgeLimit, checkBridgePair } from "./pair.js";
import { putBridge } from "./store.js";
import { bridged } from "./wording.js";

/** A bridge as a preview takes it: what is sent and received, no addresses. */
export interface BridgePairInput {
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  /** In token units, as the user gives it. */
  amount: string;
}

export interface BridgeInput extends BridgePairInput {
  fromAddress?: string;
  toAddress?: string;
}

interface Side {
  chain: ChainInfo;
  symbol: string;
  address: string;
  /** In token units. */
  amount: string;
}

export interface BridgeQuote {
  status: "ready";
  bridgeId: string;
  /** ISO time: the steps must be signed and sent before it. */
  expiresAt: string;
  expiresInSec: number;
  from: Side;
  /** What the recipient gets. */
  to: Side;
  /** The connection's fee, in the token sent. */
  partnerFee?: { amount: string; symbol: string };
  fromAddress: string;
  toAddress: string;
  steps: SwapStep[];
}

/** What a bridge would do, building and holding nothing: for showing it before the user is ready to sign. */
export interface BridgePreview {
  status: "preview";
  from: Side;
  /** What the recipient would get. */
  to: Side;
  partnerFee?: { amount: string; symbol: string };
  /** The most this route takes now, in the token sent. */
  maxAmount: string;
  /** What sodax_bridge_prepare needs besides these arguments. */
  prepareNeeds: ("fromAddress" | "toAddress")[];
}

/** What a preview and a prepare check first, reading no chain: the sides, the source, the pair and the amounts. */
function checkedPair(input: BridgePairInput, partnerFee?: PartnerFee) {
  const catalog = getBridgeCatalog();
  const from: BridgeSide = bridged(() =>
    resolveExactly(catalog, input.fromChain, input.fromToken, "fromToken", "from"),
  );
  const to: BridgeSide = bridged(() => resolveExactly(catalog, input.toChain, input.toToken, "toToken", "to"));
  // Only a chain track can prove the deposit on: nothing else would submit it.
  const source = bridged(() => sourceChainFor(catalog, from.chain));
  checkBridgePair(catalog, from, to);
  const amount = parseUnits(input.amount, from.token.decimals);
  const { delivered, feeInSource } = bridgeAmounts(amount, chainToken(from), chainToken(to), partnerFee);
  if (delivered === 0n) {
    throw new ActionError("AMOUNT_TOO_LOW", "The amount is too small: the recipient would get nothing.", {
      details: { field: "amount" },
    });
  }
  const fromType = catalog.chains[from.chain.key]?.type;
  const toType = catalog.chains[to.chain.key]?.type;
  return {
    from,
    to,
    source,
    toType,
    amount,
    delivered,
    // An EVM sender's address is theirs on an EVM destination too; any other pair needs the recipient given.
    defaultsToSender: fromType === "EVM" && toType === "EVM",
    partnerFee:
      feeInSource > 0n
        ? { amount: formatUnits(feeInSource, from.token.decimals), symbol: from.token.symbol }
        : undefined,
  };
}

export async function previewBridge(input: BridgePairInput, partnerFee?: PartnerFee): Promise<BridgePreview> {
  const { from, to, amount, delivered, defaultsToSender, ...checked } = checkedPair(input, partnerFee);
  const maxAmount = await checkBridgeLimit(amount, from, to);
  return {
    status: "preview",
    from: describe(from, amount),
    to: describe(to, delivered),
    ...(checked.partnerFee && { partnerFee: checked.partnerFee }),
    maxAmount,
    prepareNeeds: defaultsToSender ? ["fromAddress"] : ["fromAddress", "toAddress"],
  };
}

// A placeholder sender would hand the recipient's share to whoever holds the burn address's keys: nobody.
const EVM_BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export async function prepareBridge(input: BridgeInput, partnerFee?: PartnerFee): Promise<BridgeQuote> {
  const { from, to, source, toType, amount, delivered, defaultsToSender, ...checked } = checkedPair(input, partnerFee);
  const fromAddress = input.fromAddress ? checkAddress(input.fromAddress, from.chain, "fromAddress") : undefined;
  if (fromAddress) source.adapter.checkSender?.(fromAddress);
  const toAddress = input.toAddress
    ? checkAddress(input.toAddress, to.chain, "toAddress")
    : defaultsToSender
      ? fromAddress
      : undefined;
  // A recipient that defaults to the sender isn't asked for: it comes with fromAddress.
  const missing = [...(fromAddress ? [] : ["fromAddress"]), ...(toAddress || defaultsToSender ? [] : ["toAddress"])];
  if (!fromAddress || !toAddress) {
    throw new ActionError("INVALID_ADDRESS", `Preparing a bridge needs ${missing.join(" and ")}.`, {
      nextStep: `Ask the user for ${missing.join(" and ")}, then call sodax_bridge_prepare again with them.`,
      details: { field: missing[0], missing },
    });
  }
  if (toType === "EVM" && same(toAddress, EVM_BURN_ADDRESS)) {
    throw new ActionError("INVALID_ADDRESS", `That address burns whatever it receives on ${to.chain.name}.`, {
      details: { field: input.toAddress ? "toAddress" : "fromAddress" },
    });
  }

  await Promise.all([
    checkBridgeLimit(amount, from, to),
    bridged(() =>
      checkRecipient({
        chainKey: to.chain.key,
        chainType: toType ?? "",
        chainName: to.chain.name,
        token: to.token,
        address: toAddress,
        amount: delivered,
      }),
    ),
  ]);

  const request: BridgeRequest = {
    srcChainKey: from.chain.key,
    dstChainKey: to.chain.key,
    inputToken: from.token.address,
    outputToken: to.token.address,
    inputAmount: amount,
    srcAddress: fromAddress,
    dstAddress: toAddress,
    partnerFee,
  };
  const { steps, relayData, deposit } =
    source.adapter.family === "EVM"
      ? await evmSteps(request, from)
      : await buildNonEvmBridge(request, { ...source, chain: from.chain }, from.token.symbol).then(
          ({ step, relayData }) => ({ steps: [step], relayData, deposit: undefined }),
        );
  const kept = putBridge({
    request,
    relayData,
    delivered,
    ...(deposit && isHubChain(from.chain.key) && { deposit: { to: deposit.to, data: deposit.data } }),
  });
  return {
    status: "ready",
    bridgeId: kept.bridgeId,
    expiresAt: new Date(kept.signBy).toISOString(),
    expiresInSec: Math.round((kept.signBy - Date.now()) / 1000),
    from: describe(from, amount),
    to: describe(to, delivered),
    ...(checked.partnerFee && { partnerFee: checked.partnerFee }),
    fromAddress,
    toAddress,
    steps,
  };
}

/** The approvals, if any, then the deposit, for an EVM wallet on the source chain. */
async function evmSteps(
  request: BridgeRequest,
  from: BridgeSide,
): Promise<{ steps: EvmStep[]; relayData: { address: string; payload: string }; deposit: EvmTx }> {
  const chainId = evmChainIdFor(from.chain.key);
  if (chainId === undefined)
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SDK config has no chain id for that chain.");
  const { deposit, relayData, approvals } = await buildEvmBridge(request, from.token.isNative);
  const steps: EvmStep[] = [
    ...approvals.map(
      ({ kind, tx, amount }): EvmStep => ({
        kind,
        chainId,
        tx: toStepTx(tx, chainId),
        approves: {
          token: tx.to,
          symbol: from.token.symbol,
          // The spender the calldata names, which the build check matched.
          spender: `0x${tx.data.slice(34, 74)}`,
          amount: formatUnits(amount, from.token.decimals),
        },
      }),
    ),
    { kind: "bridge", chainId, tx: toStepTx(deposit, chainId) },
  ];
  return { steps, relayData, deposit };
}

const chainToken = ({ chain, token }: BridgeSide) => ({ chainKey: chain.key, address: token.address });

function describe({ chain, token }: { chain: ChainInfo; token: SwapsApiToken }, baseUnits: bigint): Side {
  return { chain, symbol: token.symbol, address: token.address, amount: formatUnits(baseUnits, token.decimals) };
}
