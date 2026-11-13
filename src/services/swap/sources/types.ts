/**
 * What the swap flow (quote, track, cancel) and the source adapters share. Types only, besides one constant, so
 * the SDK wrapper, the adapters and the flow load without each other.
 */

import type { ChainInfo } from "../../sodaxApi.js";
import type { CachedQuote } from "../quoteCache.js";
import type { BuiltIntent, EvmTx, Intent, IntentRequest } from "../swapsApi.js";

/**
 * The non-EVM families a swap can start from. Not Bitcoin (its swaps go through a Bound trading wallet), Stacks
 * (the SDK can't build its cancel) or ICON (being retired).
 */
export const NON_EVM_SOURCE_TYPES = ["NEAR", "STELLAR", "SUI", "SOLANA", "INJECTIVE"] as const;
export type NonEvmSourceType = (typeof NON_EVM_SOURCE_TYPES)[number];
export type SourceFamily = "EVM" | NonEvmSourceType;

/** A `connection` message, its bytes as `0x` hex. */
export interface ConnectionMessage {
  srcChainId: bigint;
  srcAddress: string;
  dstChainId: bigint;
  dstAddress: string;
  payload: string;
}

/**
 * A spoke tx that ran: the messages its `connection` sent. A failed tx is rolled back, so it has none, except on
 * NEAR, whose receipts that ran stay: there its messages are kept, and a deposit among them is held.
 */
export interface SpokeEvidence {
  failed: boolean;
  messages: ConnectionMessage[];
}

/**
 * What a source tx that ran proves, never its raw form: on the hub, the intents its contract created and cancelled;
 * on a spoke, its `connection`'s messages.
 */
export type SourceTx =
  | { kind: "hub"; failed: boolean; created: string[]; cancelled: string[] }
  | ({ kind: "spoke" } & SpokeEvidence);

interface SourceBase {
  adapter: SourceAdapter;
  /** What the swap tx calls: a spoke's asset manager, or the hub's intents contract, as the SDK config spells it. */
  swapContract: string;
  /** An EVM chain's id, for the steps its wallet sends. */
  chainId?: number;
}

/** The hub: its swap tx creates the intent itself, so nothing is relayed and an unsubmitted intent is refunded. */
export interface HubSource extends SourceBase {
  kind: "hub";
}

/** A spoke: its `connection`'s messages prove a deposit or a cancel. */
export interface SpokeSource extends SourceBase {
  kind: "spoke";
  /** As the SDK config spells it: only its messages count. */
  connection: string;
  /** The asset manager as its deposits' messages name it. */
  depositor: string;
}

/** A chain a swap can start from, pinned from the SDK config. */
export type SourceChain = HubSource | SpokeSource;

/** A source with the chain it's on and, from a quote, that quote. */
export type SwapSource = SourceChain & { chain: ChainInfo; quote?: CachedQuote };

/** `value` and `chainId` are hex quantities. */
export type StepTx = EvmTx & { chainId: string };

/** A step an EVM wallet sends. */
export interface EvmStep {
  kind: "reset_approve" | "approve" | "swap";
  chainId: number;
  tx: StepTx;
}

/** A non-EVM step: the SDK's unsigned raw tx for the family's wallets, as JSON (`jsonSafe`). */
export interface NonEvmStep {
  kind: "swap" | "cancel";
  chainKey: string;
  chainType: NonEvmSourceType;
  tx: unknown;
}

export type SwapStep = EvmStep | NonEvmStep;

/** What the user's wallet sends to cancel: an EVM tx, or a non-EVM spoke's raw tx. */
export type CancelStep = { kind: "cancel"; chainId: number; tx: StepTx } | NonEvmStep;

/**
 * EIP-5792 `wallet_sendCalls`, for wallets that batch: it replaces the steps it lists. Its `calls` are
 * those steps' `{to, value, data}` in order, left to the agent so the calldata isn't returned twice.
 */
export interface SwapBatch {
  replaces: EvmStep["kind"][];
  method: "wallet_sendCalls";
  params: [{ version: "2.0.0"; chainId: string; from: string; atomicRequired: true }];
}

/** A swap whose intent the quote checked, for its source to build the steps of. */
export interface SwapToBuild {
  request: IntentRequest;
  built: BuiltIntent;
  /** The token's allowance (or trustline room) already covers the amount. */
  approved: boolean;
  symbol: string;
}

/**
 * What differs by source chain, as plain functions: each source names one (`pinnedSourceOf`), so quote, track and
 * cancel never ask which family a chain is. Reads fail as bare errors, carrying no RPC text.
 */
export interface SourceAdapter {
  /** The family of the wallets that send its steps. */
  family: SourceFamily;
  /** How its chain spells a tx hash, as the backend keys a swap on the exact string; `format` names the shape. */
  txHash: { format: string; spell(text: string): string | undefined };
  /** Its messages carry a payload's keccak only (Solana), so the relay takes the payload with the tx. */
  commitsHash: boolean;
  /** Its public nodes drop old txs: one they don't have may be mined, not merely unseen yet. */
  prunes: boolean;
  /** What a tx proves once it ran, or `null` before. `sender` routes a NEAR lookup. */
  read(source: SwapSource, txHash: string, sender?: string): Promise<SourceTx | null>;
  /** Whether its node knows the tx at all, mined or pending. Only an EVM node can say; others answer false. */
  seen(source: SwapSource, txHash: string): Promise<boolean>;
  /** A read a ready quote makes first where building the swap doesn't read the chain, so a dead RPC fails then. */
  probe?(chainKey: string): Promise<unknown>;
  /** Refuses a sender whose swaps its chain can't prove. */
  checkSender?(address: string): void;
  /** The steps the user's wallet sends for the checked intent, checked as far as the family allows. */
  prepareSwap(source: SwapSource, swap: SwapToBuild): Promise<{ steps: SwapStep[]; batch?: SwapBatch }>;
  /** The cancel step for the hub's intent, checked before anyone signs it. */
  cancelStep(source: SwapSource, intent: Intent): Promise<CancelStep>;
}
