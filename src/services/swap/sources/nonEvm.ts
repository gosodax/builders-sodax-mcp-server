/**
 * What the non-EVM families share. Their steps are built here by the SDK from the checked intent: blockhash,
 * sequence and fees make the Swaps API's own build differ from any rebuild, so it can't be checked byte for byte.
 * A tx is read in one bounded call, as what its `connection`'s events prove; no node of theirs can say whether it
 * knows a tx still in flight.
 */

import { BASE58, base58Bytes, isRecord } from "../../../constants.js";
import { logger } from "../../logger.js";
import { RPC_CALL_TIMEOUT_MS, bounded, buildNonEvmCancel, buildNonEvmDeposit } from "../../sodax.js";
import { ActionError } from "../errors.js";
import type { NonEvmSourceType, NonEvmStep, SourceAdapter, SpokeEvidence, SwapSource } from "./types.js";

/** A base58 tx hash of `size` bytes. The length alone lets through text of another size, which a node refuses as an error. */
export const base58Hash = (size: 32 | 64) => {
  const pattern = new RegExp(`^[${BASE58}]{${size === 64 ? "86,88" : "32,44"}}$`);
  return (text: string) => (pattern.test(text) && base58Bytes(text).length === size ? text : undefined);
};

export interface NonEvmFamily {
  family: NonEvmSourceType;
  txHash: SourceAdapter["txHash"];
  /** Its messages carry a payload's keccak only. */
  commitsHash?: boolean;
  /** The evidence for a tx, or `null` while the chain doesn't know it or hasn't run it. A shape it doesn't know throws. */
  fetch(tx: { chainKey: string; connection: string; txHash: string; sender?: string }): Promise<SpokeEvidence | null>;
  /** Where the SDK reads a build's target from the chain, so an RPC could move it: whether it's the one it must be. */
  callsPinned?(kind: NonEvmStep["kind"], raw: unknown, expected?: unknown): boolean;
  /** The SDK's raw tx made ready for a wallet. */
  finish?(raw: unknown): unknown;
  /** The refusal of an amount its allowance doesn't cover, where the family has one of its own. */
  notApproved?(symbol: string): ActionError;
  probe?: SourceAdapter["probe"];
  checkSender?: SourceAdapter["checkSender"];
}

/** A non-EVM family's adapter, from what is its own. */
export function nonEvmAdapter(family: NonEvmFamily): SourceAdapter {
  return {
    family: family.family,
    txHash: family.txHash,
    commitsHash: family.commitsHash ?? false,
    prunes: true,
    async read(source, txHash, sender) {
      if (source.kind !== "spoke") throw new Error("not a spoke");
      const { chain, connection } = source;
      const evidence = await bounded({ label: "non-EVM tx", chainKey: chain.key, timeoutMs: RPC_CALL_TIMEOUT_MS }, () =>
        family.fetch({ chainKey: chain.key, connection, txHash, sender }),
      );
      return evidence && { kind: "spoke", ...evidence };
    },
    seen: async () => false,
    ...(family.probe && { probe: family.probe }),
    ...(family.checkSender && { checkSender: family.checkSender }),
    async prepareSwap(source, { request, built, approved, symbol }) {
      const { chain } = source;
      if (!approved) {
        throw (
          family.notApproved?.(symbol) ??
          new ActionError(
            "SWAP_REJECTED",
            `The swap service says ${symbol} on ${chain.name} needs an approval this server can't build.`,
            {
              nextStep: `Tell the user a swap of ${symbol} from ${chain.name} isn't available here for now.`,
            },
          )
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
      return { steps: [stepOf(family, source, "swap", raw, isRecord(built.tx) ? built.tx.to : undefined)] };
    },
    async cancelStep(source, intent) {
      const { chain } = source;
      const raw = await buildNonEvmCancel(chain.key, intent).catch(() => {
        throw new ActionError("CHAIN_UNAVAILABLE", `Couldn't prepare the cancel on ${chain.name} right now.`);
      });
      return stepOf(family, source, "cancel", raw);
    },
  };
}

/** The SDK's build as the step a wallet signs, refused if it calls another program than it must. */
function stepOf(
  family: NonEvmFamily,
  source: SwapSource,
  kind: NonEvmStep["kind"],
  built: unknown,
  expected?: unknown,
): NonEvmStep {
  const chainKey = source.chain.key;
  const raw = family.finish ? family.finish(built) : built;
  if (family.callsPinned && !family.callsPinned(kind, raw, expected)) {
    logger.error({ "chain.key": chainKey }, `The SDK built a ${kind} to another program than expected`);
    throw new ActionError("SWAP_MISMATCH", `The ${kind} built here calls another program than expected.`, {
      details: { chainKey },
    });
  }
  return toNonEvmStep(kind, family.family, chainKey, raw);
}

/**
 * The SDK's raw tx as JSON, its shape kept: bigints as decimal strings, bytes as base64. The signing hints name
 * its fields, which the contract tests check on live builds.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

export function toNonEvmStep(
  kind: NonEvmStep["kind"],
  family: NonEvmSourceType,
  chainKey: string,
  raw: unknown,
): NonEvmStep {
  if (!isRecord(raw)) {
    throw new ActionError("INTERNAL", "The SDK built a transaction this server doesn't recognize.");
  }
  return { kind, chainKey, chainType: family, tx: jsonSafe(raw) };
}
