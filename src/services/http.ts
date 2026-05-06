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
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
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
