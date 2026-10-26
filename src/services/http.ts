/**
 * Tiny HTTP helpers around native `fetch`.
 *
 * `fetchJson` throws on non-2xx; `fetchJsonOrNull` returns `null` on 404 for
 * lookup-style endpoints where "not found" is a normal outcome.
 */

import { SODAX_API_BASE_URL, SODAX_SOLVER_BASE_URL, SODAX_SWAPS_BASE_URL } from "../constants.js";
import { getRequestContext } from "./requestContext.js";

interface FetchJsonOptions {
  timeout?: number;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Routes that take the caller's key: the data API, the solver and the Swaps API. Other routes on the
// same host reach other origins; the relay, for one, must never get it.
const KEYED_BASE_URLS = [SODAX_API_BASE_URL, SODAX_SOLVER_BASE_URL, SODAX_SWAPS_BASE_URL].map(base => `${base}/`);

/** The caller's key, if `url` may carry it. `href` has `..` segments resolved. */
function forwardedApiKey(url: string): string | undefined {
  const { apiKey } = getRequestContext();
  if (!apiKey) return undefined;
  const { href } = new URL(url);
  return KEYED_BASE_URLS.some(base => href.startsWith(base)) ? apiKey : undefined;
}

/**
 * A non-2xx response. The message is the one callers already show; the parts ride along for
 * callers that map them. The raw body is not kept, so logging the error stays small.
 */
export class HttpError extends Error {
  readonly apiMessage?: string;
  readonly apiCode?: unknown;
  readonly retryAfterSec?: number;

  constructor(
    message: string,
    readonly status: number,
    parts: { apiMessage?: string; apiCode?: unknown; retryAfterSec?: number } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.apiMessage = parts.apiMessage;
    this.apiCode = parts.apiCode;
    this.retryAfterSec = parts.retryAfterSec;
  }
}

/** `Retry-After` as seconds from now: either delta-seconds or an HTTP date. */
function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Extract a human-readable message (and the API's error `code`, if any) from an error
 * response body so callers see *why* a request failed, not just the status code. Handles
 * the SODAX / FastAPI shapes (`{ detail: { message } }`, `{ detail: "..." }`,
 * `{ detail: [{ msg }] }`) plus `{ message }` (a string or NestJS's string list) / `{ error }`.
 */
function parseApiError(rawBody: string): { message?: string; code?: unknown } {
  const text = rawBody.trim();
  if (!text) return {};

  let code: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      code = obj.code;
      const message = extractApiErrorMessage(obj);
      if (message) return { message, code };
    }
  } catch {
    // Body wasn't JSON; fall through to the raw-text snippet below.
  }

  return { message: text.length > 300 ? `${text.slice(0, 300)}...` : text, code };
}

function extractApiErrorMessage(obj: Record<string, unknown>): string | undefined {
  const detail = obj.detail;

  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map(d => (d && typeof d === "object" ? (d as Record<string, unknown>).msg : null))
      .filter((m): m is string => typeof m === "string");
    if (msgs.length > 0) return msgs.join("; ");
  } else if (detail && typeof detail === "object") {
    const msg = (detail as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }

  if (typeof obj.message === "string") return obj.message;
  if (Array.isArray(obj.message) && obj.message.every(m => typeof m === "string")) return obj.message.join("; ");
  if (typeof obj.error === "string") return obj.error;
  return undefined;
}

async function request<T>(url: string, options: FetchJsonOptions, allow404: boolean): Promise<T | null> {
  const { timeout = DEFAULT_TIMEOUT_MS, method = "GET", body, headers } = options;

  const apiKey = forwardedApiKey(url);
  const response = await fetch(url, {
    method,
    headers: { ...DEFAULT_HEADERS, ...(apiKey ? { "x-api-key": apiKey } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // fetch keeps custom headers across a cross-origin redirect, so a keyed request never follows one.
    redirect: apiKey ? "error" : "follow",
    signal: AbortSignal.timeout(timeout),
  });

  if (allow404 && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const { message: apiMessage, code: apiCode } = parseApiError(await response.text().catch(() => ""));
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    const base = `${status} for ${url}`;
    throw new HttpError(apiMessage ? `${base} - ${apiMessage}` : base, response.status, {
      apiMessage,
      apiCode,
      retryAfterSec: retryAfterSeconds(response.headers.get("Retry-After")),
    });
  }

  // 204 No Content / empty body: response.json() would throw a cryptic
  // "Unexpected end of JSON input" SyntaxError. Trim first so whitespace-
  // only bodies ("\n", " ") are treated as empty. For the OrNull variant
  // an empty body is the same shape as a 404 — return null. For strict
  // fetchJson, throw a clearer error instead of returning undefined-as-T,
  // which would otherwise lie about the Promise<T> contract and let an
  // undefined parsed value leak into callers (caching, destructuring etc).
  const text = (await response.text()).trim();
  if (!text) {
    if (allow404) return null;
    throw new Error(`Empty response body from ${url}`);
  }
  return JSON.parse(text) as T;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  return (await request<T>(url, options, false)) as T;
}

export async function fetchJsonOrNull<T>(url: string, options: FetchJsonOptions = {}): Promise<T | null> {
  return request<T>(url, options, true);
}
