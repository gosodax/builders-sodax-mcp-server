/**
 * Tiny HTTP helpers around native `fetch`.
 *
 * `fetchJson` throws on non-2xx; `fetchJsonOrNull` returns `null` on 404 for
 * lookup-style endpoints where "not found" is a normal outcome.
 *
 * SECURITY — error surface (audit http-fetch-layer:H-1):
 * Errors thrown here are interpolated into MCP tool results and pino logs, so
 * `error.message` is treated as a *public* string. It therefore contains only
 * (a) the HTTP status and (b) a redacted, shape-only version of the request
 * path. It never contains the request query string, identifier path segments
 * (wallet addresses, tx hashes), or any bytes of the upstream response body.
 *
 * The rich detail (full URL, raw body, extracted upstream message) is still
 * available for local debugging, but only *deliberately*: it lives on
 * non-enumerable properties of the thrown `HttpError`. Non-enumerable means
 * `String(err)`, template interpolation, `JSON.stringify(err)` and pino's
 * standard error serializer (which copies own *enumerable* props) all skip it,
 * so it cannot leak by accident — you have to reach for
 * `getHttpErrorDetail(err)` on purpose.
 */

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

/** Hard cap on any upstream-derived string a caller may choose to surface. */
const MAX_UPSTREAM_DETAIL_CHARS = 120;

/** Placeholder substituted for identifier-looking path segments. */
const ID_PLACEHOLDER = ":id";

/** Rich, deliberately-not-stringified context about a failed request. */
export interface HttpErrorDetail {
  /** Full request URL, query string included. Never put this in a message. */
  url: string;
  method: string;
  status: number;
  statusText: string;
  /** Raw upstream response body (untrusted). Never put this in a message. */
  body: string;
  /** Upstream message extracted from known JSON shapes, sanitized + capped. */
  apiMessage: string | null;
}

/** Error thrown for non-2xx responses. `message` is safe to surface as-is. */
export class HttpError extends Error {
  readonly status: number;
  /** Shape-only path, e.g. `/intent/user/:id`. Safe to surface. */
  readonly redactedUrl: string;

  constructor(message: string, status: number, redactedUrl: string, detail: HttpErrorDetail) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.redactedUrl = redactedUrl;
    Object.defineProperty(this, "detail", {
      value: detail,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/**
 * Retrieve the rich (unsafe-to-surface) detail attached to an `HttpError`.
 * Intended for local debug logging and tests only.
 */
export function getHttpErrorDetail(error: unknown): HttpErrorDetail | null {
  if (!(error instanceof HttpError)) return null;
  return (error as HttpError & { detail?: HttpErrorDetail }).detail ?? null;
}

/**
 * True when a path segment looks like an identifier rather than a route name:
 * hex addresses / tx hashes (`0x...`), pure numbers, and long opaque tokens
 * (uuids, base58 ids, base64url ids).
 */
function looksLikeIdentifier(segment: string): boolean {
  if (/^0x[0-9a-fA-F]+$/.test(segment)) return true;
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-fA-F]{32,}$/.test(segment)) return true;
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment)) return true;
  // Long opaque token with no separators — keep short human-readable route
  // names (`moneymarket`, `positions`) intact.
  if (segment.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment)) return true;
  return false;
}

/**
 * Reduce a URL to a debuggable *shape*: origin + path, query and fragment
 * dropped entirely, identifier-looking segments replaced with `:id`.
 * `https://api.example.com/intent/user/0xabc...?limit=10`
 *   -> `https://api.example.com/intent/user/:id`
 */
export function redactUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Not absolute / not parseable — keep only the part before any `?` or `#`
    // and still scrub identifier segments.
    const path = rawUrl.split(/[?#]/, 1)[0] ?? "";
    return redactPath(path);
  }
  return `${parsed.origin}${redactPath(parsed.pathname)}`;
}

function redactPath(pathname: string): string {
  return pathname
    .split("/")
    .map(seg => (seg && looksLikeIdentifier(seg) ? ID_PLACEHOLDER : seg))
    .join("/");
}

/**
 * Make an untrusted upstream string safe to *optionally* surface: strip
 * control characters, neutralize markdown / prompt-injection punctuation,
 * collapse whitespace, and hard-cap the length.
 */
export function sanitizeUpstreamText(input: string): string {
  const cleaned = input
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[`*_~[\]<>#|{}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_UPSTREAM_DETAIL_CHARS ? `${cleaned.slice(0, MAX_UPSTREAM_DETAIL_CHARS)}...` : cleaned;
}

/**
 * Extract a human-readable message from an error response body. Handles the
 * SODAX / FastAPI shapes (`{ detail: { message } }`, `{ detail: "..." }`,
 * `{ detail: [{ msg }] }`) plus `{ message }` / `{ error }`.
 *
 * Only *known* JSON fields are extracted — a non-JSON body is never echoed
 * back, not even as a snippet. The result is sanitized and capped and is still
 * only reachable through `getHttpErrorDetail`; it is not part of
 * `error.message`.
 */
function extractApiErrorMessage(rawBody: string): string | null {
  const text = rawBody.trim();
  if (!text) return null;

  let extracted: string | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const detail = obj.detail;

      if (typeof detail === "string") {
        extracted = detail;
      } else if (Array.isArray(detail)) {
        const msgs = detail
          .map(d => (d && typeof d === "object" ? (d as Record<string, unknown>).msg : null))
          .filter((m): m is string => typeof m === "string");
        if (msgs.length > 0) extracted = msgs.join("; ");
      } else if (detail && typeof detail === "object") {
        const msg = (detail as Record<string, unknown>).message;
        if (typeof msg === "string") extracted = msg;
      }

      if (extracted === null && typeof obj.message === "string") extracted = obj.message;
      if (extracted === null && typeof obj.error === "string") extracted = obj.error;
    }
  } catch {
    // Body wasn't JSON — deliberately do not echo raw bytes back to callers.
    return null;
  }

  if (extracted === null) return null;
  const safe = sanitizeUpstreamText(extracted);
  return safe.length > 0 ? safe : null;
}

async function request<T>(url: string, options: FetchJsonOptions, allow404: boolean): Promise<T | null> {
  const { timeout = DEFAULT_TIMEOUT_MS, method = "GET", body, headers } = options;

  const response = await fetch(url, {
    method,
    headers: { ...DEFAULT_HEADERS, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });

  const redacted = redactUrl(url);

  if (allow404 && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    // Stable, non-reflective message: status + route shape only.
    throw new HttpError(`${status} for ${method} ${redacted}`, response.status, redacted, {
      url,
      method,
      status: response.status,
      statusText: response.statusText,
      body: rawBody,
      apiMessage: extractApiErrorMessage(rawBody),
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
    throw new Error(`Empty response body from ${method} ${redacted}`);
  }
  return JSON.parse(text) as T;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  return (await request<T>(url, options, false)) as T;
}

export async function fetchJsonOrNull<T>(url: string, options: FetchJsonOptions = {}): Promise<T | null> {
  return request<T>(url, options, true);
}
