import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SODAX_API_BASE_URL } from "../constants.js";
import { API_KEY_HINT, fetchJson, fetchJsonOrNull } from "./http.js";
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
  const sodaxUrl = `${SODAX_API_BASE_URL}/config/spoke/chains`;
  const sentKey = () => ((fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)["x-api-key"];

  it("sends the caller's key to the SODAX API", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("{}", { status: 200 }));
    await runWithRequestContext({ apiKey: "k1" }, () => fetchJson(sodaxUrl));
    expect(sentKey()).toBe("k1");
  });

  it("never sends the key to another host", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("{}", { status: 200 }));
    await runWithRequestContext({ apiKey: "k1" }, () => fetchJson("https://docs.sodax.com/mcp"));
    expect(sentKey()).toBeUndefined();
  });

  it("sends no key when the caller has none", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("{}", { status: 200 }));
    await fetchJson(sodaxUrl);
    expect(sentKey()).toBeUndefined();
  });

  it.each([401, 403])("tells the agent how to fix a rejected key (%i)", async status => {
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"message":"Invalid API key"}', { status }));
    await expect(fetchJson(sodaxUrl)).rejects.toThrow(`Invalid API key. ${API_KEY_HINT}`);
  });

  it("adds no key hint to another host's 401", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("nope", { status: 401 }));
    const error = await fetchJson("https://example.com/x").catch((e: Error) => e);
    expect((error as Error).message).not.toContain(API_KEY_HINT);
  });
});
