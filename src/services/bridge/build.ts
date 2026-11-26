/**
 * A bridge as the user's wallet will send it. The Bridge API builds it (ADR 0001 D3; its build runs the hub
 * simulation, and its allowance check says whether an approve is needed, D5), and the SDK builds it here too
 * (`sdkBridge`): any difference is refused before anyone signs.
 *
 * From an EVM spoke or Sonic, the Bridge API's tx is the one signed, checked byte for byte against the SDK's. From a
 * non-EVM spoke, blockhash, sequence and fees make any two builds differ, so the SDK's tx is the one signed, as for
 * the swap tools, checked by its family (`depositStep`). Either way the relay data, which the hub derives the same way
 * whatever the chain, must equal the SDK's.
 */

import { createHash } from "node:crypto";
import { HUB_CHAIN_KEY } from "@sodax/types";
import { isRecord, sameHex as same } from "../../constants.js";
import { logger } from "../logger.js";
import { SdkRefusal, isHubChain, sdkBridge } from "../sodax.js";
import { ActionError } from "../swap/errors.js";
import { toChain } from "../swap/resolver.js";
import { approveBatch, approveTxs, approvesExactly, chainIdOf, toStepTx } from "../swap/sources/evm.js";
import type { EvmStep, NonEvmStep, SwapBatch, SwapSource } from "../swap/sources/types.js";
import { type EvmTx, asEvmTx } from "../swap/swapsApi.js";
import type { SwapsApiToken } from "../swap/tokens.js";
import { formatUnits } from "../swap/units.js";
import {
  type BridgeRequest,
  type BuiltBridge,
  buildBridge,
  buildBridgeApproval,
  checkBridgeAllowance,
} from "./bridgeApi.js";

/**
 * From an EVM spoke or Sonic: built by the Bridge API and checked against the SDK's own build, then the steps the
 * wallet sends, any approvals (a reset to zero first when the token needs one) before the deposit.
 */
export async function buildEvmBridge(
  request: BridgeRequest,
  source: SwapSource,
  token: SwapsApiToken,
): Promise<{ steps: EvmStep[]; batch?: SwapBatch; relayData: BuiltBridge["relayData"]; deposit: EvmTx }> {
  const [built, approved, rebuilt] = await Promise.all([
    buildBridge(request),
    token.isNative || checkBridgeAllowance(request),
    // The SDK's build reads the user's hub wallet on the hub.
    sdkBridge(request).catch(
      refusedOr(() => new ActionError("CHAIN_UNAVAILABLE", `Couldn't read ${toChain(HUB_CHAIN_KEY).name} right now.`)),
    ),
  ]);
  const deposit = asEvmTx(built.tx);
  const expected = asEvmTx(withDecimalValue(rebuilt.tx));
  if (!deposit || !expected) throw bridgeMismatch(request, deposit ? "rebuild" : "tx", built.tx);
  const mismatch = findMismatch([
    ["tx.from", same(deposit.from, request.srcAddress)],
    ["tx.to", same(deposit.to, expected.to)],
    ["tx.value", deposit.value === expected.value],
    ["tx.data", same(deposit.data, expected.data)],
    ...relayChecks(built, rebuilt),
  ]);
  if (mismatch) throw bridgeMismatch(request, mismatch, built.tx);

  // The spender: from a spoke the asset manager the deposit calls, from Sonic the user's hub wallet, which pulls the
  // token (the SDK's `resolveEvmApprovalSpender`).
  const spender = isHubChain(request.srcChainKey) ? rebuilt.relayData.address : deposit.to;
  const approvals = approved ? [] : approveTxs(await buildBridgeApproval(request), request.amount);
  const approval = { from: request.srcAddress, token: request.srcToken, spender };
  if (!approvals.every(step => approvesExactly(step, approval))) {
    throw bridgeMismatch(request, "approval", approvals.at(-1)?.tx);
  }
  const chainId = chainIdOf(source);
  // Each approve's calldata was just matched byte for byte to `approve(spender, amount)`: what the wallet signs.
  const steps: EvmStep[] = [
    ...approvals.map(
      ({ kind, tx, amount }): EvmStep => ({
        kind,
        chainId,
        tx: toStepTx(tx, chainId),
        approves: { token: tx.to, symbol: token.symbol, spender, amount: formatUnits(amount, token.decimals) },
      }),
    ),
    { kind: "bridge", chainId, tx: toStepTx(deposit, chainId) },
  ];
  // A batch sends the deposit from the wallet's own code, in a tx a relayer or bundler may send. From a spoke its message
  // still proves it (track refuses a tx with other relay messages); from Sonic track checks the deposit as the tx itself,
  // which a batch's tx isn't, so there it's sent alone.
  const batch =
    approvals.length > 0 && !isHubChain(request.srcChainKey)
      ? approveBatch(chainId, request.srcAddress, "bridge")
      : undefined;
  return { steps, ...(batch && { batch }), relayData: built.relayData, deposit };
}

/**
 * From a non-EVM spoke: the deposit step the SDK built, checked by its family against the program the Bridge API's
 * own build calls, and the relay data both agree on.
 */
export async function buildNonEvmBridge(
  request: BridgeRequest,
  source: SwapSource,
  symbol: string,
): Promise<{ steps: NonEvmStep[]; relayData: BuiltBridge["relayData"] }> {
  const { adapter, chain } = source;
  if (!adapter.depositStep) throw new ActionError("INTERNAL", "Not a non-EVM source.");
  const [built, approved, rebuilt] = await Promise.all([
    buildBridge(request),
    checkBridgeAllowance(request),
    // The SDK reads the chain to build it (account, blockhash, coins, fees), and a wallet it can't build for fails the
    // same way as an outage: the Bridge API built it a moment ago, so a retry is more likely to help.
    sdkBridge(request).catch(
      refusedOr(
        () =>
          new ActionError("CHAIN_UNAVAILABLE", `Couldn't prepare the bridge on ${chain.name} right now.`, {
            nextStep: `Retry in a minute. If it still fails, ask the user to check their ${chain.name} wallet holds the amount plus fees and has sent a transaction before, then call sodax_bridge_prepare again.`,
          }),
      ),
    ),
  ]);
  const relayMismatch = findMismatch(relayChecks(built, rebuilt));
  if (relayMismatch) throw bridgeMismatch(request, relayMismatch, built.tx);
  if (!approved) throw notApproved(source, symbol);
  const expected = isRecord(built.tx) ? built.tx.to : undefined;
  return { steps: [adapter.depositStep(source, rebuilt.tx, expected)], relayData: built.relayData };
}

/** An allowance short of the amount: only Stellar has one from a non-EVM spoke, its trustline's room. */
function notApproved({ adapter, chain }: SwapSource, symbol: string): ActionError {
  if (adapter.family === "STELLAR") {
    return new ActionError("BRIDGE_REJECTED", `The wallet's ${symbol} trustline has too little room for this amount.`, {
      nextStep: `Tell the user their Stellar wallet must raise its ${symbol} trustline limit by the amount sent, then call sodax_bridge_prepare again.`,
      details: { reason: "trustline_room" },
    });
  }
  return new ActionError(
    "BRIDGE_REJECTED",
    `The bridge service says ${symbol} on ${chain.name} needs an approval this server can't build.`,
    {
      nextStep: `Tell the user a bridge of ${symbol} from ${chain.name} isn't available here for now.`,
      details: { reason: "approval_unbuildable" },
    },
  );
}

/** The relay data, which the hub derives the same way whatever the source, must be the SDK's. */
function relayChecks(built: BuiltBridge, rebuilt: { relayData: BuiltBridge["relayData"] }): [string, boolean][] {
  return [
    ["relayData.address", same(built.relayData.address, rebuilt.relayData.address)],
    ["relayData.payload", same(built.relayData.payload, rebuilt.relayData.payload)],
  ];
}

/**
 * A failed SDK build: params the SDK refuses (a Bitcoin delivery below dust, say) fail before any read and never
 * pass, so they're the bridge's refusal, not an outage to retry; anything else is `failure`.
 */
const refusedOr =
  (failure: () => ActionError) =>
  (error: unknown): never => {
    if (!(error instanceof SdkRefusal)) throw failure();
    if (error.field === "amount") {
      throw new ActionError("AMOUNT_TOO_LOW", "The amount is too small to bridge on this route.", {
        nextStep: "Ask the user whether to bridge a larger amount.",
        details: { field: "amount" },
      });
    }
    throw new ActionError("BRIDGE_REJECTED", "This bridge can't be built as asked.", {
      nextStep: "Tell the user this bridge isn't available as asked; ask whether to try another token or chain.",
      details: { reason: "sdk_refused" },
    });
  };

/** The SDK's raw EVM tx carries its value as a bigint; the API's as a decimal string. */
function withDecimalValue(tx: unknown): unknown {
  if (!tx || typeof tx !== "object" || !("value" in tx) || typeof tx.value !== "bigint") return tx;
  return { ...tx, value: tx.value.toString() };
}

/** The first check that fails, by name. */
function findMismatch(checks: [string, boolean][]): string | undefined {
  return checks.find(([, ok]) => !ok)?.[0];
}

/** Possibly a compromised or broken upstream: enough to investigate, no user addresses. */
function bridgeMismatch(request: BridgeRequest, mismatch: string, builtTx: unknown): ActionError {
  const tx = asEvmTx(builtTx);
  const dataSha256 = tx && createHash("sha256").update(tx.data.toLowerCase()).digest("hex");
  logger.error(
    {
      mismatch,
      "chain.key": request.srcChainKey,
      "dst_chain.key": request.dstChainKey,
      ...(tx && { "tx.to": tx.to, "tx.data_sha256": dataSha256 }),
    },
    "The Bridge API built a bridge that doesn't match the SDK's",
  );
  return new ActionError("BRIDGE_MISMATCH", "The bridge service built a different bridge than the one asked for.", {
    details: { chainKey: request.srcChainKey },
  });
}
