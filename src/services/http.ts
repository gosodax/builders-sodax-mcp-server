/**
 * Tiny HTTP helpers around native `fetch`.
 *
 * `fetchJson` throws on non-2xx; `fetchJsonOrNull` returns `null` on 404 for
 * lookup-style endpoints where "not found" is a normal outcome.
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
  "Accept": "application/json",
};

/**
 * Extract a human-readable message from an error response body so callers
 * see *why* a request failed, not just the status code. Handles the SODAX /
 * FastAPI shapes (`{ detail: { message } }`, `{ detail: "..." }`,
 * `{ detail: [{ msg }] }`) plus `{ message }` / `{ error }`.
 */
function extractApiErrorMessage(rawBody: string): string | null {
  const text = rawBody.trim();
  if (!text) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
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
      if (typeof obj.error === "string") return obj.error;
    }
  } catch {
    // Body wasn't JSON; fall through to the raw-text snippet below.
  }

  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

async function request<T>(
  url: string,
  options: FetchJsonOptions,
  allow404: boolean
): Promise<T | null> {
  const { timeout = DEFAULT_TIMEOUT_MS, method = "GET", body, headers } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: { ...DEFAULT_HEADERS, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (allow404 && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const apiMessage = extractApiErrorMessage(await response.text().catch(() => ""));
      const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      const base = `${status} for ${url}`;
      throw new Error(apiMessage ? `${base} - ${apiMessage}` : base);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  return (await request<T>(url, options, false)) as T;
}

export async function fetchJsonOrNull<T>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T | null> {
  return request<T>(url, options, true);
}
