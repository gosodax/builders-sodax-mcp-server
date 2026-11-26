/** Bridge service results, wrapped in their real decisions for contract and runtime tests. */

import type { BridgePairs } from "../../services/bridge/pair.js";
import type { BridgePreview, BridgeQuote } from "../../services/bridge/prepare.js";
import type { BridgeTrack } from "../../services/bridge/track.js";
import { forBridge } from "../../services/bridge/wording.js";
import { ActionError, type ActionErrorCode } from "../../services/swap/errors.js";
import { pairsDecision, prepareDecision, previewDecision, trackDecision } from "../bridgeDecisions.js";
import type { SwapToolName } from "../nextAction.js";
import { errorDecision } from "../swapDecisions.js";
import type { ToolResult } from "./nextActionRuntime.js";
import { ARBITRUM, LATER, SONIC, TX } from "./swapResults.js";

export { ARBITRUM, LATER, NOW, SONIC, TX } from "./swapResults.js";

/** A bridge tool's failure as it returns it: reworded for a bridge before its decision, as `registerActionTool` does. */
export const failure = (
  code: ActionErrorCode,
  tool: SwapToolName,
  args: Record<string, unknown>,
  details?: Record<string, unknown>,
  retryable?: boolean,
): ToolResult => {
  const error = forBridge(new ActionError(code, "No.", { details, retryable }));
  return { status: "error", error: { ...details, code }, ...errorDecision(error, { tool, args }) };
};
export const BASE = { key: "0x2105.base", name: "Base" };
export const BRIDGE_ID = "3e1a8620-798c-4dfa-8149-b803fad31f3a";
export const HUB_TX = `0x${"b".repeat(64)}`;
export const USER = `0x${"1".repeat(40)}`;
const FROM_TOKEN = `0x${"2".repeat(40)}`;
const TO_TOKEN = `0x${"3".repeat(40)}`;
const SPENDER = `0x${"4".repeat(40)}`;

export const PAIRS: BridgePairs = {
  status: "ok",
  from: ARBITRUM,
  to: BASE,
  pairs: [{ from: { symbol: "USDC", address: FROM_TOKEN }, to: { symbol: "USDC", address: TO_TOKEN } }],
};
export const PAIR_ARGS = {
  fromChain: ARBITRUM.key,
  fromToken: FROM_TOKEN,
  toChain: BASE.key,
  toToken: TO_TOKEN,
};
export const PREVIEW: BridgePreview = {
  status: "preview",
  from: { chain: ARBITRUM, symbol: "USDC", address: FROM_TOKEN, amount: "5" },
  to: { chain: BASE, symbol: "USDC", address: TO_TOKEN, amount: "5" },
  maxAmount: "100",
  prepareNeeds: ["fromAddress"],
};
const tx = (to: string) => ({ from: USER, to, data: "0x1234", value: "0x0", chainId: "0xa4b1" });
export const READY: BridgeQuote = {
  status: "ready",
  bridgeId: BRIDGE_ID,
  expiresAt: LATER,
  expiresInSec: 1200,
  from: PREVIEW.from,
  to: PREVIEW.to,
  fromAddress: USER,
  toAddress: USER,
  steps: [
    {
      kind: "approve",
      chainId: 42161,
      tx: tx(FROM_TOKEN),
      approves: { token: FROM_TOKEN, spender: SPENDER, amount: "5", symbol: "USDC" },
    },
    { kind: "bridge", chainId: 42161, tx: tx(SPENDER) },
  ],
  batch: {
    replaces: ["approve", "bridge"],
    method: "wallet_sendCalls",
    params: [{ version: "2.0.0", chainId: "0xa4b1", from: USER, atomicRequired: true }],
  },
};
export const NON_EVM_READY: BridgeQuote = {
  ...READY,
  from: { chain: { key: "solana", name: "Solana" }, symbol: "SOL", address: "native", amount: "0.5" },
  to: { chain: SONIC, symbol: "SOL", address: TO_TOKEN, amount: "0.5" },
  fromAddress: "solana-wallet",
  steps: [{ kind: "bridge", chainKey: "solana", chainType: "SOLANA", tx: { recentBlockhash: "blockhash" } }],
  batch: undefined,
};

export type TrackState = {
  [Status in BridgeTrack["status"]]: Omit<Extract<BridgeTrack, { status: Status }>, "txHash" | "chain" | "bridgeId">;
}[BridgeTrack["status"]];

export const ref = (chain = ARBITRUM, txHash = TX, bridgeId: string | undefined = BRIDGE_ID) => ({
  chain,
  txHash,
  ...(bridgeId && { bridgeId }),
});
export const listed = (pairs = PAIRS): ToolResult => ({ ...pairs, ...pairsDecision(pairs) });
export const previewed = (preview = PREVIEW): ToolResult => ({ ...preview, ...previewDecision(preview) });
export const prepared = (quote = READY): ToolResult => ({ ...quote, ...prepareDecision(quote) });
export const tracked = (state: TrackState, bridge = ref()): ToolResult => {
  const result = { ...bridge, ...state } as BridgeTrack;
  return { ...result, ...trackDecision(result) };
};
