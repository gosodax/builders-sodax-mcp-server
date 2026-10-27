/**
 * The Swaps API over REST (`/v1/swaps`). Not the SDK's SwapsApiService: it retries
 * a 429 at once and drops the response headers, so `Retry-After` would be lost.
 * Responses are checked with zod; failures become errors the agent can act on.
 */

import { z } from "zod";
import { EVM_ADDRESS_PATTERN, SODAX_SWAPS_BASE_URL } from "../../constants.js";
import { HttpError, fetchJson } from "../http.js";
import { logger } from "../logger.js";
import type { PartnerFee } from "../partnerFee.js";
import { ActionError, type ActionErrorCode } from "./errors.js";

const TIMEOUT_MS = 15_000;
const UINT = /^\d+$/;
const HEX_DATA = /^0x[0-9a-fA-F]*$/;
const evmAddress = z.string().regex(EVM_ADDRESS_PATTERN);

const evmTxSchema = z.object({
  from: evmAddress,
  to: evmAddress,
  value: z.string().regex(UINT),
  data: z.string().regex(HEX_DATA),
});
export type EvmTx = z.infer<typeof evmTxSchema>;

// The 14 intent fields `createIntent` takes, and nothing else: track submits the intent back, and
// the backend refuses unknown keys.
const intentSchema = z.object({
  intentId: z.string().regex(UINT),
  creator: evmAddress,
  inputToken: evmAddress,
  outputToken: evmAddress,
  inputAmount: z.string().regex(UINT),
  minOutputAmount: z.string().regex(UINT),
  deadline: z.string().regex(UINT),
  allowPartialFill: z.boolean(),
  srcChain: z.string().regex(UINT),
  dstChain: z.string().regex(UINT),
  srcAddress: z.string().regex(HEX_DATA),
  dstAddress: z.string().regex(HEX_DATA),
  solver: evmAddress,
  /** The fee envelope: `0x` without a partner fee. */
  data: z.string().regex(HEX_DATA),
});

const builtIntentSchema = z.object({
  tx: evmTxSchema,
  intent: intentSchema,
  relayData: z.object({ address: evmAddress, payload: z.string().regex(HEX_DATA) }),
});
export type BuiltIntent = z.infer<typeof builtIntentSchema>;

interface QuoteRequest {
  tokenSrc: string;
  tokenSrcChainKey: string;
  tokenDst: string;
  tokenDstChainKey: string;
  amount: bigint;
  partnerFee?: PartnerFee;
}

/** The body `/intents`, `/allowance/check` and `/approve` share. */
export interface IntentRequest {
  srcChainKey: string;
  dstChainKey: string;
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  minOutputAmount: bigint;
  deadline: string;
  srcAddress: string;
  dstAddress: string;
  partnerFee?: PartnerFee;
}

/** Output amount for an exact input, in base units of the destination token. The partner fee is already taken. */
export async function getQuote(request: QuoteRequest): Promise<bigint> {
  const { amount, partnerFee, ...rest } = request;
  const body = { ...rest, amount: amount.toString(), quoteType: "exact_input", ...wirePartnerFee(partnerFee) };
  const { quotedAmount } = await call(z.object({ quotedAmount: z.string().regex(UINT) }), "/quote", body);
  return BigInt(quotedAmount);
}

// The hub clock may run a little off ours; anything further off is not a deadline we asked for.
const MAX_CLOCK_SKEW_SEC = 300;
// However the clocks differ, the user needs at least this long to sign and send.
const MIN_TIME_TO_SEND_SEC = 120;

/** A deadline `offsetSeconds` from now on the hub clock (unix seconds). */
export async function getDeadline(offsetSeconds: number): Promise<string> {
  const { deadline } = await call(
    z.object({ deadline: z.string().regex(UINT) }),
    `/deadline?offsetSeconds=${offsetSeconds}`,
  );
  const offBy = Number(deadline) - (Math.floor(Date.now() / 1000) + offsetSeconds);
  if (Math.abs(offBy) > MAX_CLOCK_SKEW_SEC) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The swap service returned an unusable deadline.");
  }
  if (!leavesTimeToSend(deadline)) {
    throw new ActionError("DEADLINE_TOO_SHORT", "That deadline leaves too little time to send the swap.");
  }
  return deadline;
}

/** Whether a deadline (unix seconds) still leaves the user time to sign and send. */
export function leavesTimeToSend(deadline: string): boolean {
  return Number(deadline) - Math.floor(Date.now() / 1000) >= MIN_TIME_TO_SEND_SEC;
}

export async function buildIntent(request: IntentRequest): Promise<BuiltIntent> {
  return call(builtIntentSchema, "/intents", intentBody(request));
}

/** Whether the source token is already approved for this swap (always true for a native token). */
export async function checkAllowance(request: IntentRequest): Promise<boolean> {
  const { valid } = await call(z.object({ valid: z.boolean() }), "/allowance/check", intentBody(request));
  return valid;
}

/** The approve tx, plus a reset to zero first for tokens that require it (USDT-style). */
export interface Approval {
  tx: EvmTx;
  resetTx?: EvmTx;
}

export async function buildApprove(request: IntentRequest): Promise<Approval> {
  return call(z.object({ tx: evmTxSchema, resetTx: evmTxSchema.optional() }), "/approve", intentBody(request));
}

function intentBody(request: IntentRequest): Record<string, unknown> {
  const { inputAmount, minOutputAmount, partnerFee, ...rest } = request;
  return {
    ...rest,
    inputAmount: inputAmount.toString(),
    minOutputAmount: minOutputAmount.toString(),
    allowPartialFill: false,
    ...wirePartnerFee(partnerFee),
  };
}

function wirePartnerFee(partnerFee?: PartnerFee): { partnerFee?: { address: string; percentage: number } } {
  return partnerFee ? { partnerFee: { address: partnerFee.address, percentage: partnerFee.bps } } : {};
}

async function call<T>(schema: z.ZodType<T>, path: string, body?: unknown): Promise<T> {
  const route = path.split("?")[0];
  let raw: unknown;
  try {
    raw = await fetchJson<unknown>(`${SODAX_SWAPS_BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      body,
      timeout: TIMEOUT_MS,
    });
  } catch (error) {
    throw toActionError(error, route);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    logger.error({ route }, "Unexpected Swaps API response");
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX swap service returned an unexpected response.");
  }
  return parsed.data;
}

interface Refusal {
  code: ActionErrorCode;
  message: string;
  nextStep?: string;
}

/** A refusal a smaller amount or another token may get past. */
const tryOther = (message: string, reason: string): Refusal => ({
  code: "SWAP_REJECTED",
  message,
  nextStep: `Tell the user ${reason}; ask whether to try a smaller amount or another token.`,
});
const NO_ROUTE = tryOther("No route was found for this pair at this amount.", "no route was found");
const NO_LIQUIDITY = tryOther(
  "There isn't enough liquidity for this pair at this amount.",
  "there isn't enough liquidity",
);

// Upstream codes with a reason the agent can act on: the solver's (the SDK's SolverIntentErrorCode), and -23.
const REFUSALS = new Map<number, Refusal>([
  // What the live solver answers for "no path", which the SDK names -4.
  [-1, NO_ROUTE],
  [-4, NO_ROUTE],
  [-5, NO_LIQUIDITY],
  // Also the SDK's QUOTE_NOT_FOUND, but only the solver's execute returns that, and nothing here calls it.
  [-8, NO_LIQUIDITY],
  [-14, tryOther("The amount is too large for the swap service to quote.", "the amount is too large")],
  [-23, { code: "AMOUNT_TOO_LOW", message: "The amount is too small for the swap service to quote." }],
]);

function toActionError(error: unknown, route: string): ActionError {
  if (!(error instanceof HttpError)) {
    logger.warn({ err: error, route }, "Swaps API call failed");
    return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX swap service is unavailable.");
  }
  // The status, code and reason go to the log, not to the agent: upstream text isn't ours to pass on.
  const { status, apiCode, apiMessage } = error;
  // The code is upstream data of any shape; only a short scalar is worth a log field.
  const code =
    typeof apiCode === "number" || (typeof apiCode === "string" && apiCode.length <= 64) ? apiCode : undefined;
  logger.warn({ route, status, apiCode: code, apiMessage }, "Swaps API call failed");
  if (status === 401 || status === 403) {
    return new ActionError("API_KEY_REQUIRED", "The swap service needs a valid SODAX API key.");
  }
  if (status === 429) {
    return new ActionError("RATE_LIMITED", "The swap service is rate-limiting these requests.", {
      details: { retryAfterSec: error.retryAfterSec ?? 60 },
    });
  }
  // Only these two say something about the swap itself; a 404 or 408 is the service's problem.
  if (status === 400 || status === 422) {
    const refusal = typeof code === "number" ? REFUSALS.get(code) : undefined;
    if (refusal) return new ActionError(refusal.code, refusal.message, { nextStep: refusal.nextStep });
    return new ActionError("SWAP_REJECTED", "The swap service refused this swap.");
  }
  return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX swap service is unavailable.");
}
