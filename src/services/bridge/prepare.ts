/**
 * `sodax_bridge_prepare`: a bridge checked end to end before anything is built (pair, addresses, recipient, limit),
 * built by the Bridge API and checked against the SDK's own build, then kept for submit and track. A bridge moves one
 * asset 1:1 through its hub vault, so there's no price to quote: what's received is the amount sent, less any partner
 * fee, in the received token's decimals.
 */

import { sameHex as same } from "../../constants.js";
import type { PartnerFee } from "../partnerFee.js";
import { bridgeAmounts, isHubChain } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { checkRecipient } from "../swap/destination.js";
import { ActionError } from "../swap/errors.js";
import { type AddressField, EVM_BURN_ADDRESS, addressesNeeded, resolveSide } from "../swap/quote.js";
import { checkAddress } from "../swap/resolver.js";
import { sourceChainFor } from "../swap/source.js";
import type { SwapBatch, SwapStep } from "../swap/sources/types.js";
import { type SwapsApiToken, nativeToken } from "../swap/tokens.js";
import { formatUnits, parseUnits } from "../swap/units.js";
import type { BridgeRequest } from "./bridgeApi.js";
import { buildEvmBridge, buildNonEvmBridge } from "./build.js";
import { getBridgeCatalog } from "./catalog.js";
import { chainToken, checkBridgeLimit, checkBridgePair } from "./pair.js";
import { checkBridgeRoom, putBridge } from "./store.js";

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

/**
 * What the user pays besides any partner fee: the bridge charges nothing of its own, and the source chain's gas is
 * the wallet's to set, in that chain's native token. Never estimated here.
 */
export interface NetworkFee {
  paidIn?: string;
  estimated: false;
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
  networkFee: NetworkFee;
  fromAddress: string;
  toAddress: string;
  steps: SwapStep[];
  /** From an EVM spoke with an approve: the approve and the bridge as one EIP-5792 batch, for a wallet that batches. */
  batch?: SwapBatch;
}

/** What a bridge would do, building and holding nothing: for showing it before the user is ready to sign. */
export interface BridgePreview {
  status: "preview";
  from: Side;
  /** What the recipient would get. */
  to: Side;
  partnerFee?: { amount: string; symbol: string };
  networkFee: NetworkFee;
  /** The most this route takes now, in the token sent. */
  maxAmount: string;
  /** What sodax_bridge_prepare needs besides these arguments. */
  prepareNeeds: ("fromAddress" | "toAddress")[];
}

/** What a preview and a prepare check first, reading no chain: the sides, the source, the pair and the amounts. */
function checkedPair(input: BridgePairInput, partnerFee?: PartnerFee) {
  const catalog = getBridgeCatalog();
  const from = resolveSide(catalog, input.fromChain, input.fromToken, "from");
  const to = resolveSide(catalog, input.toChain, input.toToken, "to");
  // Only a chain track can prove the deposit on: nothing else would submit it.
  const source = { ...sourceChainFor(catalog, from.chain), chain: from.chain };
  checkBridgePair(catalog, from, to);
  const amount = parseUnits(input.amount, from.token.decimals);
  const { delivered, feeInSource } = bridgeAmounts(amount, chainToken(from), chainToken(to), partnerFee);
  if (delivered === 0n) {
    throw new ActionError("AMOUNT_TOO_LOW", "The amount is too small: the recipient would get nothing.", {
      nextStep: "Ask the user whether to bridge a larger amount.",
      details: { field: "amount" },
    });
  }
  // The wallet pays the source chain's gas, in its native token; nothing here estimates it.
  const native = nativeToken(catalog, from.chain.key);
  return {
    from,
    to,
    source,
    amount,
    delivered,
    // An EVM sender's address is theirs on an EVM destination too; any other pair needs the recipient given.
    defaultsToSender: from.config.type === "EVM" && to.config.type === "EVM",
    networkFee: { ...(native && { paidIn: native.symbol }), estimated: false as const },
    fee:
      feeInSource > 0n
        ? { amount: formatUnits(feeInSource, from.token.decimals), symbol: from.token.symbol }
        : undefined,
  };
}

export async function previewBridge(input: BridgePairInput, partnerFee?: PartnerFee): Promise<BridgePreview> {
  const { from, to, amount, delivered, defaultsToSender, fee, networkFee } = checkedPair(input, partnerFee);
  const maxAmount = await checkBridgeLimit(amount, from, to);
  return {
    status: "preview",
    from: describe(from, amount),
    to: describe(to, delivered),
    ...(fee && { partnerFee: fee }),
    networkFee,
    maxAmount,
    prepareNeeds: defaultsToSender ? ["fromAddress"] : ["fromAddress", "toAddress"],
  };
}

export async function prepareBridge(input: BridgeInput, partnerFee?: PartnerFee): Promise<BridgeQuote> {
  const { from, to, source, amount, delivered, defaultsToSender, fee, networkFee } = checkedPair(input, partnerFee);
  const fromAddress = input.fromAddress ? checkAddress(input.fromAddress, from.chain, "fromAddress") : undefined;
  if (fromAddress) source.adapter.checkSender?.(fromAddress);
  const toAddress = input.toAddress
    ? checkAddress(input.toAddress, to.chain, "toAddress")
    : defaultsToSender
      ? fromAddress
      : undefined;
  // The recipient the bridge ends with, the sender's own address included: a placeholder sender pays the burn address.
  if (toAddress && to.config.type === "EVM" && same(toAddress, EVM_BURN_ADDRESS)) {
    throw new ActionError("INVALID_ADDRESS", `That address burns whatever it receives on ${to.chain.name}.`, {
      details: { field: input.toAddress ? "toAddress" : "fromAddress" },
    });
  }
  // A recipient that defaults to the sender isn't asked for: it comes with fromAddress.
  const missing: AddressField[] = [];
  if (!fromAddress) missing.push("fromAddress");
  if (!toAddress && !defaultsToSender) missing.push("toAddress");
  if (!fromAddress || !toAddress) throw addressesNeeded(missing, from.chain, to.chain);
  // Before any upstream call, so a key at its cap of open bridges costs nothing.
  checkBridgeRoom();

  await Promise.all([
    checkBridgeLimit(amount, from, to),
    checkRecipient({
      chainKey: to.chain.key,
      chainType: to.config.type,
      chainName: to.chain.name,
      token: to.token,
      address: toAddress,
      amount: delivered,
    }),
  ]);

  const request: BridgeRequest = {
    srcChainKey: from.chain.key,
    srcAddress: fromAddress,
    srcToken: from.token.address,
    amount,
    dstChainKey: to.chain.key,
    dstToken: to.token.address,
    recipient: toAddress,
    partnerFee,
  };
  const built =
    source.adapter.family === "EVM"
      ? await buildEvmBridge(request, source, from.token)
      : await buildNonEvmBridge(request, source, from.token.symbol);
  const kept = putBridge({
    request,
    relayData: built.relayData,
    delivered,
    // From Sonic a hub tx logs no message to check the deposit by, so the tx itself is kept.
    ...("deposit" in built &&
      isHubChain(from.chain.key) && {
        deposit: { to: built.deposit.to, data: built.deposit.data, value: built.deposit.value },
      }),
  });
  return {
    status: "ready",
    bridgeId: kept.bridgeId,
    expiresAt: new Date(kept.signBy).toISOString(),
    expiresInSec: Math.round((kept.signBy - Date.now()) / 1000),
    from: describe(from, amount),
    to: describe(to, delivered),
    ...(fee && { partnerFee: fee }),
    networkFee,
    fromAddress,
    toAddress,
    steps: built.steps,
    ...("batch" in built && built.batch && { batch: built.batch }),
  };
}

function describe({ chain, token }: { chain: ChainInfo; token: SwapsApiToken }, baseUnits: bigint): Side {
  return { chain, symbol: token.symbol, address: token.address, amount: formatUnits(baseUnits, token.decimals) };
}
