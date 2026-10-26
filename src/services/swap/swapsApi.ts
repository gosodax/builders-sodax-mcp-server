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
import { ActionError } from "./errors.js";

const TIMEOUT_MS = 15_000;
const UINT = /^\d+$/;

const evmTxSchema = z.object({
  from: z.string().regex(EVM_ADDRESS_PATTERN),
  to: z.string().regex(EVM_ADDRESS_PATTERN),
  value: z.string().regex(UINT),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
});
export type EvmTx = z.infer<typeof evmTxSchema>;

const builtIntentSchema = z.object({
  tx: evmTxSchema,
  // Kept whole: track submits it back verbatim.
  intent: z
    .object({
      inputToken: z.string(),
      outputToken: z.string(),
      inputAmount: z.string().regex(UINT),
      minOutputAmount: z.string().regex(UINT),
      deadline: z.string().regex(UINT),
      allowPartialFill: z.boolean(),
      srcAddress: z.string(),
      dstAddress: z.string(),
      solver: z.string(),
      /** The fee envelope: `0x` without a partner fee. */
      data: z.string(),
    })
    .passthrough(),
  relayData: z.object({ address: z.string(), payload: z.string() }),
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
// Never earlier than asked by more than this: a deadline that is already near would expire in flight.
const MAX_EARLY_SEC = 60;

/** A deadline `offsetSeconds` from now on the hub clock (unix seconds). */
export async function getDeadline(offsetSeconds: number): Promise<string> {
  const { deadline } = await call(
    z.object({ deadline: z.string().regex(UINT) }),
    `/deadline?offsetSeconds=${offsetSeconds}`,
  );
  const expected = Math.floor(Date.now() / 1000) + offsetSeconds;
  const offBy = Number(deadline) - expected;
  if (offBy < -MAX_EARLY_SEC || offBy > MAX_CLOCK_SKEW_SEC) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The swap service returned an unusable deadline.");
  }
  return deadline;
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
  let raw: unknown;
  try {
    raw = await fetchJson<unknown>(`${SODAX_SWAPS_BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      body,
      timeout: TIMEOUT_MS,
    });
  } catch (error) {
    throw toActionError(error, path.split("?")[0]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    logger.error({ path: path.split("?")[0] }, "Unexpected Swaps API response");
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX swap service returned an unexpected response.");
  }
  return parsed.data;
}

function toActionError(error: unknown, path: string): ActionError {
  if (error instanceof HttpError) {
    // The status, code and reason go to the log, not to the agent: upstream text isn't ours to pass on.
    if (error.status < 500) {
      const { status, apiCode, apiMessage } = error;
      logger.warn({ path, status, apiCode, apiMessage: apiMessage?.slice(0, 300) }, "Swaps API refused a request");
    }
    if (error.status === 401 || error.status === 403) {
      return new ActionError("API_KEY_REQUIRED", "The swap service needs a valid SODAX API key.");
    }
    if (error.status === 429) {
      return new ActionError("RATE_LIMITED", "The swap service is rate-limiting these requests.", {
        details: { retryAfterSec: error.retryAfterSec ?? 60 },
      });
    }
    if (error.status === 422 && error.apiCode === -23) {
      return new ActionError("AMOUNT_TOO_LOW", "The amount is too small for the swap service to quote.");
    }
    // Only these two say something about the swap itself; a 404 or 408 is the service's problem.
    if (error.status === 400 || error.status === 422) {
      return new ActionError("SWAP_REJECTED", "The swap service refused this swap.", {
        details: { status: error.status },
      });
    }
  }
  logger.warn({ err: error, path }, "Swaps API call failed");
  return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX swap service is unavailable.");
}
