/**
 * Per-request context (the caller's API key) for outbound SODAX API calls.
 *
 * HTTP: each MCP request runs inside `runWithRequestContext`, so concurrent
 * callers never see each other's key. stdio serves one client per process, so
 * it sets a fallback context once from env instead.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  apiKey?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();
let fallback: RequestContext = {};

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? fallback;
}

/** stdio only. In HTTP mode a caller without a key stays keyless. */
export function setFallbackRequestContext(context: RequestContext): void {
  fallback = context;
}
