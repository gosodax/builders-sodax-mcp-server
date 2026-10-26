import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SODAX_API_BASE_URL,
  SODAX_API_ORIGIN,
  SODAX_RELAY_BASE_URL,
  SODAX_SOLVER_BASE_URL,
  SODAX_SWAPS_BASE_URL,
} from "../constants.js";
import { HttpError, fetchJson, fetchJsonOrNull } from "./http.js";
import { runWithRequestContext } from "./requestContext.js";

type FetchSpy = ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

let fetchSpy: FetchSpy;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
});

function jsonResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe("fetchJson", () => {
  it("returns parsed JSON on 2xx", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"ok":true}', { status: 200 }));
    await expect(fetchJson<{ ok: boolean }>("http://example.com/x")).resolves.toEqual({ ok: true });
  });

  it("throws on 400 and surfaces the API detail string in the message", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"detail":"bad input"}', { status: 400, statusText: "Bad Request" }));
    await expect(fetchJson("http://example.com/x")).rejects.toThrow(/HTTP 400.*bad input/);
  });

  it("throws on 500 even when the body is plain text", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("Server boom", { status: 500 }));
    await expect(fetchJson("http://example.com/x")).rejects.toThrow(/HTTP 500.*Server boom/);
  });

  it("throws a clear 'Empty response body' error instead of SyntaxError on an empty 200", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("", { status: 200 }));
    await expect(fetchJson("http://example.com/x")).rejects.toThrow(
      /Empty response body from http:\/\/example\.com\/x/,
    );
  });

  it("throws 'Empty response body' on 204 No Content", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(fetchJson("http://example.com/x")).rejects.toThrow(/Empty response body/);
  });

  it("treats a whitespace-only body as empty (trims before checking)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("\n  \t\n", { status: 200 }));
    await expect(fetchJson("http://example.com/x")).rejects.toThrow(/Empty response body/);
  });
});

describe("HttpError", () => {
  const failure = () =>
    fetchJson("https://example.com/x").then(
      () => expect.unreachable(),
      (error: unknown) => error as HttpError,
    );

  it("carries the status, the API's message and code, and Retry-After in seconds, but not the raw body", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse('{"message":"slow down","code":-1}', { status: 429, headers: { "Retry-After": "7" } }),
    );
    const error = await failure();
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, apiMessage: "slow down", apiCode: -1, retryAfterSec: 7 });
    expect(error).not.toHaveProperty("body");
    expect(error.message).toBe("HTTP 429 for https://example.com/x - slow down");
  });

  it("reads an HTTP-date Retry-After as seconds from now, and leaves it unset when absent", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T12:00:00Z") });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse("", { status: 503, headers: { "Retry-After": "Mon, 26 Oct 2026 12:00:30 GMT" } }),
    );
    expect((await failure()).retryAfterSec).toBe(30);
    fetchSpy.mockResolvedValueOnce(jsonResponse("", { status: 503 }));
    expect((await failure()).retryAfterSec).toBeUndefined();
  });

  it.each([
    ["7.5", undefined],
    ["soon", undefined],
    ["99999999", 3600],
  ])("ignores a malformed Retry-After and caps a long one: %j", async (header, expected) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("", { status: 429, headers: { "Retry-After": header } }));
    expect((await failure()).retryAfterSec).toBe(expected);
  });
});

describe("error messages", () => {
  it.each([
    ['{"error":"Bad Request","code":7}', "Bad Request", 7],
    ['{"detail":{"message":"no such pool"}}', "no such pool", undefined],
    ['{"unexpected":true,"code":-1}', '{"unexpected":true,"code":-1}', -1],
  ])("reads the message and code from %s", async (body, apiMessage, apiCode) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(body, { status: 400 }));
    await expect(fetchJson("https://example.com/x")).rejects.toMatchObject({ apiMessage, apiCode });
  });

  it("joins a NestJS validation message list", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        '{"message":["amount must be a number string","deadline must be a number string"],"error":"Bad Request"}',
        { status: 400 },
      ),
    );
    await expect(fetchJson("https://example.com/x")).rejects.toMatchObject({
      apiMessage: "amount must be a number string; deadline must be a number string",
    });
  });
});

describe("fetchJsonOrNull", () => {
  it("returns null on 404", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("not found", { status: 404 }));
    await expect(fetchJsonOrNull("http://example.com/x")).resolves.toBeNull();
  });

  it("throws on non-404 non-2xx (e.g. 500)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("boom", { status: 500 }));
    await expect(fetchJsonOrNull("http://example.com/x")).rejects.toThrow(/HTTP 500/);
  });

  it("returns parsed JSON on 200", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"x":1}', { status: 200 }));
    await expect(fetchJsonOrNull<{ x: number }>("http://example.com/x")).resolves.toEqual({ x: 1 });
  });

  it("returns null on an empty 200 body (same shape as 404 for the OrNull variant)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("", { status: 200 }));
    await expect(fetchJsonOrNull("http://example.com/x")).resolves.toBeNull();
  });
});

describe("timeout", () => {
  it("aborts the request when the timeout elapses", async () => {
    // Mock fetch to honor the abort signal by rejecting when it fires.
    fetchSpy.mockImplementationOnce((_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    });

    await expect(fetchJson("http://example.com/slow", { timeout: 20 })).rejects.toThrow(/abort|TimeoutError/i);
  });

  it("does not register a manual setTimeout on the fast path (no leaked handle)", async () => {
    // Switching to AbortSignal.timeout means our code no longer schedules
    // setTimeout itself — Node owns the timer and tears it down with the
    // signal. Pinning that: a successful request shouldn't call setTimeout
    // from our module.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"ok":1}', { status: 200 }));
    await fetchJson("http://example.com/x", { timeout: 5_000 });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});

describe("headers", () => {
  it("uses the default Content-Type when caller passes none", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("{}", { status: 200 }));
    await fetchJson("http://example.com/x");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("caller-supplied Content-Type wins over the default", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("{}", { status: 200 }));
    await fetchJson("http://example.com/x", { headers: { "Content-Type": "text/plain" } });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "Content-Type": "text/plain" });
  });
});

describe("API key forwarding", () => {
  const dataUrl = `${SODAX_API_BASE_URL}/config/spoke/chains`;
  const sentInit = () => fetchSpy.mock.calls[0]?.[1] as RequestInit;
  const sentKey = () => (sentInit().headers as Record<string, string>)["x-api-key"];
  const fetchWithKey = (url: string) => runWithRequestContext({ apiKey: "sodax_k1" }, () => fetchJson(url));

  beforeEach(() => {
    fetchSpy.mockImplementation(async () => jsonResponse("{}", { status: 200 }));
  });

  it.each([dataUrl, `${SODAX_SOLVER_BASE_URL}/quote`, `${SODAX_SWAPS_BASE_URL}/tokens`])(
    "sends the caller's key to %s",
    async url => {
      await fetchWithKey(url);
      expect(sentKey()).toBe("sodax_k1");
      expect(sentInit().redirect).toBe("error");
    },
  );

  it.each([
    `${SODAX_RELAY_BASE_URL}/`,
    `${SODAX_API_ORIGIN}/v1/sponsorships/x`,
    `${SODAX_API_BASE_URL}/intent/tx/../../../sponsorships/x`,
    "https://docs.sodax.com/mcp",
  ])("never sends the key to %s", async url => {
    await fetchWithKey(url);
    expect(sentKey()).toBeUndefined();
  });

  it("sends no key and follows redirects when the caller has none", async () => {
    await fetchJson(dataUrl);
    expect(sentKey()).toBeUndefined();
    expect(sentInit().redirect).toBe("follow");
  });
});
