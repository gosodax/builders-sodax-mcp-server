/**
 * Per-request context (the caller's API key and partner fee) for outbound SODAX API calls.
 *
 * HTTP: each MCP request runs inside `runWithRequestContext`, so concurrent
 * callers never see each other's key. stdio serves one client per process, so
 * it sets a fallback context once from env instead.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { PartnerFee } from "./partnerFee.js";

export interface RequestContext {
  apiKey?: string;
  partnerFee?: PartnerFee;
  /** One MCP request (HTTP) or tool call (stdio); every log record of it carries `request.id`. */
  requestId?: string;
  /** `hashClientIp` of the request's IP: the PostHog id, and the log's `client.ip_hash` when keyed. */
  clientId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();
let fallback: RequestContext = {};

/** The context for work shared between callers (a cached read): the request's ids stay for the logs, its credentials don't. */
export function withoutCredentials(context: RequestContext = getRequestContext()): RequestContext {
  const { requestId, clientId } = context;
  return { requestId, clientId };
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? fallback;
}

/** Who the caller is, without keeping their key: what a quote is bound to. */
export function callerKeyHash(): string {
  return keyHash(getRequestContext().apiKey);
}

function keyHash(apiKey: string | undefined): string {
  return createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex");
}

/** A SHA-256 hex as log records name it (`caller.key_hash`, `mcp.session.id_hash`): its first 16 characters. */
export const tagOf = (sha256Hex: string): string => sha256Hex.slice(0, 16);

/** A secret's tag: what a record can carry instead of it (an SSE session id). */
export const hashTag = (secret: string): string => tagOf(createHash("sha256").update(secret).digest("hex"));

/** A key as log records name it, none without a key. */
export function keyTag(apiKey: string | undefined): string | undefined {
  return apiKey ? tagOf(keyHash(apiKey)) : undefined;
}

export function callerKeyTag(): string | undefined {
  return keyTag(getRequestContext().apiKey);
}

/** stdio only. In HTTP mode a caller without a key stays keyless. */
export function setFallbackRequestContext(context: RequestContext): void {
  fallback = context;
}

// SODAX keys are `sodax_` + base64url, 49 chars. Anything else (another service's secret,
// two x-api-key headers joined with ", ", an oversized value) is dropped rather than forwarded.
const SODAX_API_KEY_PATTERN = /^sodax_[A-Za-z0-9_-]+$/;
export const MAX_API_KEY_LENGTH = 128;

export function parseApiKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key && key.length <= MAX_API_KEY_LENGTH && SODAX_API_KEY_PATTERN.test(key) ? key : undefined;
}
