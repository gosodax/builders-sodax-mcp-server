/**
 * The Bridge API over REST (`/v1/bridge`), called as the swap tools call the Swaps API and for the same reason: the
 * SDK's BridgeApiService retries a 429 at once and drops `Retry-After`. The wire types are the SDK's
 * (`@sodax/types`): request bodies are typed with them, and each response schema must accept them, so an SDK bump
 * that changes the wire fails the build. Responses are still checked with zod at run time.
 *
 * Only the build routes (allowance, approve, intents) and submit-tx with its status: pairs and limits come from the
 * SDK itself (`sodax.bridge`), as its own types advise.
 */

import type {
  BridgeAllowanceCheckResponseV2,
  BridgeApproveResponseV2,
  BridgeSubmitTxRequestV2,
  BridgeSubmitTxResponseV2,
  BridgeSubmitTxStatusResponseV2,
  CreateBridgeIntentParamsV2,
  CreateBridgeIntentResponseV2,
} from "@sodax/types";
import { z } from "zod";
import { EVM_ADDRESS_PATTERN, SODAX_BRIDGE_BASE_URL } from "../../constants.js";
import { HttpError, fetchJson, fetchJsonOrNull, routeOf } from "../http.js";
import { logger, redact } from "../logger.js";
import type { PartnerFee } from "../partnerFee.js";
import { ActionError } from "../swap/errors.js";
import { type EvmTx, asEvmTx, withoutIds } from "../swap/swapsApi.js";

// Above bridge-api's own 15 s deadline on a build's chain reads, so its 504 arrives before our timeout.
const TIMEOUT_MS = 20_000;
const HEX_DATA = /^0x[0-9a-fA-F]*$/;
// `dstIntentTxHash` is the hub tx from a spoke, the destination chain's own tx from Sonic: any chain's hash format.
const TX_HASH = /^[A-Za-z0-9:_-]{1,128}$/;

/** The schema, typed so that the call fails to compile when it stops accepting the SDK's wire type `Wire`. */
const accepting =
  <Wire>() =>
  <S extends z.ZodTypeAny>(schema: S & ([Wire] extends [z.input<S>] ? unknown : never)): S =>
    schema;

const allowanceSchema = accepting<BridgeAllowanceCheckResponseV2>()(z.object({ valid: z.boolean() }));

// A tx's shape is its source family's: an EVM one is parsed where it's used.
const approveSchema = accepting<BridgeApproveResponseV2>()(
  z.object({ tx: z.unknown(), resetTx: z.unknown().optional() }),
);

const builtSchema = accepting<CreateBridgeIntentResponseV2>()(
  z.object({
    tx: z.unknown(),
    relayData: z.object({ address: z.string().regex(EVM_ADDRESS_PATTERN), payload: z.string().regex(HEX_DATA) }),
  }),
);
export type BuiltBridge = z.infer<typeof builtSchema>;

const submitSchema = accepting<BridgeSubmitTxResponseV2>()(
  z.object({ success: z.boolean(), data: z.object({ status: z.enum(["inserted", "duplicate"]) }).optional() }),
);

// Only what tracking acts on: `userMessage` and `failureReason` are upstream text and stay out. A hash that doesn't
// look like one is dropped, not passed on.
const statusSchema = accepting<BridgeSubmitTxStatusResponseV2>()(
  z.object({
    success: z.boolean(),
    data: z.object({
      status: z.string().max(64),
      failedAtStep: z.string().max(64).optional(),
      abandonedAt: z.string().max(64).optional(),
      result: z.object({ dstIntentTxHash: z.string().regex(TX_HASH).optional().catch(undefined) }).optional(),
    }),
  }),
);
export type BridgeTxStatus = z.infer<typeof statusSchema>["data"];

/** A bridge as the build routes take it. The partner fee is the connection's, never a tool input. */
export interface BridgeRequest {
  srcChainKey: string;
  dstChainKey: string;
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  srcAddress: string;
  dstAddress: string;
  partnerFee?: PartnerFee;
}

/** Whether the source token is already approved for this bridge. */
export async function checkBridgeAllowance(request: BridgeRequest): Promise<boolean> {
  const { valid } = await buildCall(allowanceSchema, "/allowance/check", request);
  return valid;
}

/** The approve tx, plus a reset to zero first for tokens that require it (USDT-style). EVM and Sonic sources only. */
export async function buildBridgeApproval(request: BridgeRequest): Promise<{ tx: EvmTx; resetTx?: EvmTx }> {
  const { tx, resetTx } = await buildCall(approveSchema, "/approve", request);
  const approve = asEvmTx(tx);
  const reset = resetTx === undefined ? undefined : asEvmTx(resetTx);
  if (!approve || (resetTx !== undefined && !reset)) throw unexpectedResponse("/approve");
  return reset ? { tx: approve, resetTx: reset } : { tx: approve };
}

/** The unsigned deposit tx and the relay data it carries, unchecked: the caller rebuilds both and compares. */
export async function buildBridge(request: BridgeRequest): Promise<BuiltBridge> {
  return buildCall(builtSchema, "/intents", request);
}

/** Hands a mined deposit to the backend, which relays it. Idempotent per tx; a different payload for one tx is 409. */
export async function submitBridgeTx(body: BridgeSubmitTxRequestV2): Promise<"inserted" | "duplicate"> {
  const { success, data } = await call(submitSchema, "/submit-tx", body);
  if (!success || !data) {
    throw new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX bridge service didn't accept the bridge for processing.");
  }
  return data.status;
}

/** The backend's record of a submitted bridge, or `null` if it has none. */
export async function getBridgeTxStatus(txHash: string, srcChainKey: string): Promise<BridgeTxStatus | null> {
  const path = `/submit-tx/status?${new URLSearchParams({ txHash, srcChainKey })}`;
  const raw = await send(path, undefined, fetchJsonOrNull);
  if (raw === null) return null;
  const { success, data } = parse(statusSchema, path, raw);
  // `success: false` is the wire's "no record", whatever `data` carries.
  return success ? data : null;
}

function requestBody({ inputAmount, partnerFee, ...rest }: BridgeRequest): CreateBridgeIntentParamsV2 {
  return {
    ...rest,
    inputAmount: inputAmount.toString(),
    ...(partnerFee && { partnerFee: { address: partnerFee.address, percentage: partnerFee.bps } }),
  };
}

/** A build-route call. One the backend couldn't build from this wallet points at the read of its balance. */
async function buildCall<T>(schema: Schema<T>, path: string, request: BridgeRequest): Promise<T> {
  try {
    return await call(schema, path, requestBody(request));
  } catch (error) {
    if (!(error instanceof ActionError) || error.details?.reason !== "wallet_cannot_build") throw error;
    const balance = {
      chain: request.srcChainKey,
      address: request.srcAddress,
      token: request.inputToken,
      for: "bridge" as const,
    };
    const { code, message, nextStep, details } = error;
    throw new ActionError(code, message, { nextStep, details, hint: { balance } });
  }
}

// Output and input differ for a schema with `.catch()`; what comes in is unchecked JSON either way.
type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

async function call<T>(schema: Schema<T>, path: string, body?: unknown): Promise<T> {
  return parse(schema, path, await send(path, body, fetchJson));
}

async function send(path: string, body: unknown, fetcher: typeof fetchJsonOrNull): Promise<unknown> {
  try {
    const options = { method: body === undefined ? "GET" : "POST", body, timeout: TIMEOUT_MS };
    return await fetcher<unknown>(`${SODAX_BRIDGE_BASE_URL}${path}`, options);
  } catch (error) {
    throw toActionError(error, urlTemplate(path));
  }
}

function parse<T>(schema: Schema<T>, path: string, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw unexpectedResponse(path);
  return parsed.data;
}

function unexpectedResponse(path: string): ActionError {
  logger.error({ "url.template": urlTemplate(path) }, "Unexpected Bridge API response");
  return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX bridge service returned an unexpected response.");
}

// The route as the "Upstream call" record names it, so one query finds both; the query string is left out.
const urlTemplate = (path: string) => routeOf(new URL(`${SODAX_BRIDGE_BASE_URL}${path}`).pathname);

const rejected = (message: string, reason: string, nextStep?: string) =>
  new ActionError("BRIDGE_REJECTED", message, { nextStep, details: { reason } });

function toActionError(error: unknown, route: string): ActionError {
  if (!(error instanceof HttpError)) {
    logger.warn({ err: error, "url.template": route }, "Bridge API call failed");
    return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX bridge service is unavailable.");
  }
  // The status, code and reason go to the log, not to the agent: upstream text isn't ours to pass on.
  const { status, apiCode, apiMessage } = error;
  // bridge-api answers an SDK failure with its `SodaxErrorCode` (`apps/bridge-api` error-mapper); only a short
  // string is one.
  const code = typeof apiCode === "string" && apiCode.length <= 64 ? apiCode : undefined;
  logger.warn(
    {
      "url.template": route,
      "http.response.status_code": status,
      "upstream.code": code,
      "upstream.message": apiMessage && withoutIds(redact(apiMessage)),
    },
    "Bridge API call failed",
  );
  // The key guard's 403 for a valid key without the route's scope: keys minted before bridge existed carry only the
  // swap scopes. A new key from the portal carries both.
  if (status === 403 && apiMessage && /\bscope\b/i.test(apiMessage)) {
    return new ActionError("API_KEY_REQUIRED", "This SODAX API key isn't allowed to use the bridge service.", {
      nextStep:
        "Tell the user their SODAX API key was made before bridging was added and needs a new key: an organisation's Owner or Admin creates one in the partner portal, https://portal.sodax.com (API keys, then Create key).",
      details: { reason: "missing_bridge_scope" },
    });
  }
  if (status === 401 || status === 403) {
    return new ActionError("API_KEY_REQUIRED", "The bridge service needs a valid SODAX API key.");
  }
  if (status === 429) {
    return new ActionError("RATE_LIMITED", "The bridge service is rate-limiting these requests.", {
      details: { retryAfterSec: error.retryAfterSec ?? 60 },
    });
  }
  if (status === 409) {
    return rejected(
      "This transaction was already submitted to the bridge service with different bridge data.",
      "submitted_differently",
    );
  }
  if (status === 422 && code === "INTENT_CREATION_FAILED") {
    return rejected(
      "The bridge service couldn't build this bridge from that wallet.",
      "wallet_cannot_build",
      "Check with sodax_get_balance that the wallet holds the amount plus fees on the source chain. If it doesn't, tell the user what's missing; if it does, tell the user the bridge couldn't be built right now and to try again later.",
    );
  }
  // An invalid request, a token or chain the service doesn't know (a 404 from a build route), or a direction the
  // token doesn't allow: something about this bridge, not the service being down.
  if (status === 400 || status === 404 || status === 422) {
    return rejected("The bridge service refused this bridge.", "rejected");
  }
  return new ActionError("UPSTREAM_UNAVAILABLE", "The SODAX bridge service is unavailable.");
}
