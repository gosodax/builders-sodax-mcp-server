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
}

const storage = new AsyncLocalStorage<RequestContext>();
let fallback: RequestContext = {};

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? fallback;
}

/** Who the caller is, without keeping their key: what a quote is bound to. */
export function callerKeyHash(): string {
  return createHash("sha256")
    .update(getRequestContext().apiKey ?? "")
    .digest("hex");
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
