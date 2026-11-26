/** Swap tool results as the services return them, for decisions and the reference runtime to be tested on. */

import type { CancelResult } from "../../services/swap/cancel.js";
import { ActionError, type ActionErrorCode } from "../../services/swap/errors.js";
import type { SwapQuote } from "../../services/swap/quote.js";
import type { TrackResult } from "../../services/swap/track.js";
import type { SwapToolName } from "../nextAction.js";
import { cancelDecision, errorDecision, quoteDecision, trackDecision } from "../swapDecisions.js";
import type { ToolResult } from "./nextActionRuntime.js";

export const ARBITRUM = { key: "0xa4b1.arbitrum", name: "Arbitrum" };
export const SONIC = { key: "sonic", name: "Sonic" };
export const SUI = { key: "sui", name: "Sui" };
export const TX = `0x${"a".repeat(64)}`;
export const CANCEL_TX = `0x${"c".repeat(64)}`;
export const QUOTE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
export const NOW = Date.parse("2026-10-26T12:00:00.000Z");
export const LATER = "2026-10-26T12:20:00.000Z";
export const ref = (chain = ARBITRUM, txHash = TX) => ({ txHash, chain, quoteId: QUOTE_ID });

const SUMMARY = {
  from: { chain: ARBITRUM, symbol: "USDC", address: "0xusdc", amount: "5" },
  to: { chain: SONIC, symbol: "S", address: "0xs", expectedAmount: "10" },
  usdValue: "5.00",
  usdOut: "5.00",
  quotedAt: LATER,
};

export const PRICE = { ...SUMMARY, status: "price", prepareNeeds: ["fromAddress"] } as unknown as SwapQuote;

export const READY = {
  ...SUMMARY,
  status: "ready",
  to: { ...SUMMARY.to, minimumAmount: "9.9" },
  slippageBps: 100,
  quoteId: QUOTE_ID,
  intentHash: "0xintent",
  expiresAt: LATER,
  expiresInSec: 1200,
  fromAddress: "0xUser",
  toAddress: "0xuser",
  checks: { balance: "not_checked", recipient: "ok" },
  steps: [
    { kind: "approve", chainId: 42161, tx: {}, approves: { spender: "0xspender", amount: "5", symbol: "USDC" } },
    { kind: "swap", chainId: 42161, tx: {} },
  ],
  batch: { replaces: ["approve", "swap"], method: "wallet_sendCalls", params: [] },
} as unknown as SwapQuote;

/** A tool's structured content: the result and its decision, as `registerActionTool` returns it. */
export const quoted = (quote: SwapQuote): ToolResult => ({ ...quote, ...quoteDecision(quote) });
export const tracked = (state: Record<string, unknown>, swap = ref()): ToolResult => {
  const result = { ...swap, ...state } as TrackResult;
  return { ...result, ...trackDecision(result) };
};
export const cancelled = (state: Record<string, unknown>, swap = ref()): ToolResult => {
  const result = { ...swap, ...state } as CancelResult;
  return { ...result, ...cancelDecision(result) };
};
export const failure = (
  code: ActionErrorCode,
  tool: SwapToolName,
  args: Record<string, unknown>,
  details?: Record<string, unknown>,
  retryable?: boolean,
): ToolResult => {
  const error = new ActionError(code, "No.", { details, retryable });
  return { status: "error", error: { ...details, code }, ...errorDecision(error, { tool, args }) };
};
