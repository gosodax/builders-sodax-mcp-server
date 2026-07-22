import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, fetchJson, fetchJsonOrNull, getHttpErrorDetail, redactUrl, sanitizeUpstreamText } from "./http.js";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}

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

  it("throws on 400 with the status but WITHOUT the upstream detail string", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"detail":"bad input"}', { status: 400, statusText: "Bad Request" }));
    const err = await captureError(() => fetchJson(`http://example.com/intent/user/${ADDRESS}`));

    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("Bad Request");
    // The upstream body must never be reflected back to the caller/LLM.
    expect(err.message).not.toContain("bad input");
    // Nor may the identifier in the URL.
    expect(err.message).not.toContain(ADDRESS);
    expect(err.message).toBe("HTTP 400 Bad Request for GET http://example.com/intent/user/:id");
  });

  it("throws on 500 with a plain-text body and never echoes that body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("Server boom", { status: 500 }));
    const err = await captureError(() => fetchJson("http://example.com/x"));

    expect(err.message).toContain("HTTP 500");
    expect(err.message).not.toContain("Server boom");
  });

  it("throws a clear 'Empty response body' error instead of SyntaxError on an empty 200", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("", { status: 200 }));
    const err = await captureError(() => fetchJson(`http://example.com/intent/tx/${ADDRESS}?limit=10`));

    expect(err.message).toContain("Empty response body");
    // Shape only: no query string, no tx hash / address.
    expect(err.message).toContain("http://example.com/intent/tx/:id");
    expect(err.message).not.toContain(ADDRESS);
    expect(err.message).not.toContain("limit=10");
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

describe("redactUrl", () => {
  it("drops the query string entirely", () => {
    expect(redactUrl("https://api.example.com/intent/quote?token=secret&limit=10")).toBe(
      "https://api.example.com/intent/quote",
    );
  });

  it("drops the fragment", () => {
    expect(redactUrl("https://api.example.com/intent/quote#frag")).toBe("https://api.example.com/intent/quote");
  });

  it("replaces hex address / tx hash segments with :id", () => {
    expect(redactUrl(`https://api.example.com/moneymarket/position/${ADDRESS}`)).toBe(
      "https://api.example.com/moneymarket/position/:id",
    );
    expect(redactUrl(`https://api.example.com/intent/tx/${ADDRESS}?limit=10`)).toBe(
      "https://api.example.com/intent/tx/:id",
    );
  });

  it("replaces numeric, uuid and long opaque id segments", () => {
    expect(redactUrl("https://api.example.com/chain/8453/assets")).toBe("https://api.example.com/chain/:id/assets");
    expect(redactUrl("https://api.example.com/job/3f0e2b1a-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(
      "https://api.example.com/job/:id",
    );
    expect(redactUrl("https://api.example.com/session/abc123def456ghi789jkl012")).toBe(
      "https://api.example.com/session/:id",
    );
  });

  it("keeps human-readable route names intact", () => {
    expect(redactUrl("https://api.example.com/moneymarket/reserves/all")).toBe(
      "https://api.example.com/moneymarket/reserves/all",
    );
  });

  it("still redacts when the URL is not parseable as absolute", () => {
    expect(redactUrl(`/intent/user/${ADDRESS}?limit=10`)).toBe("/intent/user/:id");
  });
});

describe("sanitizeUpstreamText", () => {
  it("strips control characters and markdown punctuation and collapses whitespace", () => {
    expect(sanitizeUpstreamText("**bad**\n\t`input` <b>x</b>")).toBe("bad input b x /b");
  });

  it("hard-caps the length at 120 characters", () => {
    const long = "a".repeat(500);
    const out = sanitizeUpstreamText(long);
    expect(out).toHaveLength(123); // 120 chars + "..."
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("error detail is reachable but never leaks by default", () => {
  it("keeps the full URL and raw body off the message but on the error detail", async () => {
    const url = `http://example.com/intent/user/${ADDRESS}?limit=10`;
    fetchSpy.mockResolvedValueOnce(
      jsonResponse('{"detail":"insufficient liquidity"}', { status: 422, statusText: "Unprocessable Entity" }),
    );
    const err = await captureError(() => fetchJson(url));

    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).not.toContain(ADDRESS);
    expect(err.message).not.toContain("limit=10");
    expect(err.message).not.toContain("insufficient liquidity");

    const detail = getHttpErrorDetail(err);
    expect(detail).not.toBeNull();
    expect(detail?.url).toBe(url);
    expect(detail?.status).toBe(422);
    expect(detail?.method).toBe("GET");
    expect(detail?.body).toBe('{"detail":"insufficient liquidity"}');
    expect(detail?.apiMessage).toBe("insufficient liquidity");
  });

  it("does not expose detail through stringification or enumeration (pino/JSON safe)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"detail":"secret-detail"}', { status: 400 }));
    const err = await captureError(() => fetchJson(`http://example.com/intent/user/${ADDRESS}?apiKey=shhh`));

    expect(String(err)).not.toContain("secret-detail");
    expect(String(err)).not.toContain(ADDRESS);
    expect(String(err)).not.toContain("shhh");
    expect(Object.keys(err)).not.toContain("detail");
    expect(JSON.stringify({ ...err })).not.toContain("secret-detail");
  });

  it("never extracts a message from a non-JSON body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("<html>nginx 502 upstream</html>", { status: 502 }));
    const err = await captureError(() => fetchJson("http://example.com/x"));

    expect(err.message).not.toContain("nginx");
    expect(getHttpErrorDetail(err)?.apiMessage).toBeNull();
    // Raw body is still preserved for local debugging.
    expect(getHttpErrorDetail(err)?.body).toBe("<html>nginx 502 upstream</html>");
  });

  it("caps and sanitizes an oversized upstream detail before storing it", async () => {
    const huge = "x".repeat(1000);
    fetchSpy.mockResolvedValueOnce(jsonResponse(JSON.stringify({ detail: huge }), { status: 400 }));
    const err = await captureError(() => fetchJson("http://example.com/x"));

    expect(getHttpErrorDetail(err)?.apiMessage).toHaveLength(123);
  });

  it("exposes status and redactedUrl as safe structured fields", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("{}", { status: 503, statusText: "Service Unavailable" }));
    const err = (await captureError(() =>
      fetchJson(`http://example.com/moneymarket/position/${ADDRESS}`),
    )) as HttpError;

    expect(err.status).toBe(503);
    expect(err.redactedUrl).toBe("http://example.com/moneymarket/position/:id");
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
