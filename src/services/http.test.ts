import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SODAX_API_BASE_URL,
  SODAX_API_ORIGIN,
  SODAX_RELAY_BASE_URL,
  SODAX_SOLVER_BASE_URL,
  SODAX_SWAPS_BASE_URL,
  SODAX_SWAP_ORACLE_BASE_URL,
} from "../constants.js";
import { TOOL_CONTRACT } from "./apiDriftCheck.js";
import { BadResponseError, HttpError, fetchJson, fetchJsonOrNull, routeOf } from "./http.js";
// Loads the client, which registers its routes.
import "./sodaxApi.js";
import { logger } from "./logger.js";
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

  it("names a 2xx body that isn't JSON a bad response, keeping the parser's message", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("<html>", { status: 200 }));
    const error = await fetchJson("http://example.com/x").catch(e => e);
    expect(error).toBeInstanceOf(BadResponseError);
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.message).toBe(error.cause.message);
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
    ["Sun, 06 Foo 1994 08:49:37 GMT", undefined],
    ["0", 1],
    ["99999999", 3600],
  ])("ignores a malformed Retry-After and caps a long one: %j", async (header, expected) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("", { status: 429, headers: { "Retry-After": header } }));
    expect((await failure()).retryAfterSec).toBe(expected);
  });
});

describe("error messages", () => {
  it("caps a long message from a JSON body like a raw one", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(JSON.stringify({ message: "x".repeat(1000) }), { status: 400 }));
    await expect(fetchJson("https://example.com/x")).rejects.toMatchObject({ apiMessage: `${"x".repeat(300)}...` });
  });

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

  const sentId = () => new Headers(sentInit().headers).get("X-Request-Id");
  const fetchInRequest = (url: string) => runWithRequestContext({ requestId: "req-1" }, () => fetchJson(url));

  it.each([dataUrl, `${SODAX_SWAP_ORACLE_BASE_URL}/oracle`, `${SODAX_RELAY_BASE_URL}/`])(
    "sends the request's id to %s, a SODAX API host",
    async url => {
      await fetchInRequest(url);
      expect(sentId()).toBe("req-1");
    },
  );

  it.each(["https://docs.sodax.com/mcp", "http://example.com/x"])("never sends the request's id to %s", async url => {
    await fetchInRequest(url);
    expect(sentId()).toBeNull();
  });
});

describe("upstream call records", () => {
  it("logs each call with its path, status and duration, and no query string", async () => {
    const info = vi.spyOn(logger, "info");
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"ok":true}', { status: 200 }));
    await fetchJson(`${SODAX_API_BASE_URL}/intent/user/0x${"a".repeat(40)}?address=0x1234`);
    const { hostname } = new URL(SODAX_API_BASE_URL);
    expect(info).toHaveBeenCalledWith(
      {
        "http.request.method": "GET",
        "server.address": hostname,
        "url.template": "/v1/be/intent/user/*",
        "http.response.status_code": 200,
        "duration.ms": expect.any(Number),
      },
      "Upstream call",
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/0x1234|aaaa/);
  });

  it("logs a body that fails to arrive as a failed call, with the status it came with", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const stuck = new ReadableStream({
      pull(controller) {
        controller.error(Object.assign(new Error("body timed out"), { name: "TimeoutError" }));
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(stuck, { status: 200 }));
    await expect(fetchJson(`${SODAX_API_BASE_URL}/thing`)).rejects.toThrow("body timed out");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        "url.template": "/v1/be/thing",
        "http.response.status_code": 200,
        "error.type": "TimeoutError",
      }),
      "Upstream call",
    );
    expect(info).not.toHaveBeenCalledWith(expect.anything(), "Upstream call");
  });

  it("logs a failed call at warn, and a refused connection by its cause's code", async () => {
    const warn = vi.spyOn(logger, "warn");
    fetchSpy.mockResolvedValueOnce(jsonResponse('{"detail":"nope"}', { status: 503 }));
    await expect(fetchJson(`${SODAX_API_BASE_URL}/thing`)).rejects.toBeInstanceOf(HttpError);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ "url.template": "/v1/be/thing", "http.response.status_code": 503 }),
      "Upstream call",
    );
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "TimeoutError" }));
    await expect(fetchJson(`${SODAX_API_BASE_URL}/thing`)).rejects.toThrow("boom");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ "error.type": "TimeoutError" }), "Upstream call");
    fetchSpy.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(fetchJson(`${SODAX_API_BASE_URL}/thing`)).rejects.toThrow("fetch failed");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ "error.type": "ECONNREFUSED" }), "Upstream call");
  });
});

describe("routeOf", () => {
  it.each([
    // A static word beats a parameter.
    ["/v1/be/moneymarket/asset/all", "/v1/be/moneymarket/asset/all"],
    ["/v1/be/moneymarket/asset/0xabc", "/v1/be/moneymarket/asset/*"],
    // Off the contract: the tail is masked from the fifth segment, and an id-shaped segment before that.
    ["/v1/be/config/spoke/sonic", "/v1/be/config/spoke/*"],
    ["/v1/be/intent/user/a/b", "/v1/be/intent/user/*/*"],
    ["/v1/swaps/intents/0xabc", "/v1/swaps/intents/*"],
    ["/v1/swaps/intents/alice.near", "/v1/swaps/intents/*"],
    ["/v1/swaps/intents/0xa4b1.arbitrum", "/v1/swaps/intents/*"],
    ["/v1/swaps/intents/GABC", "/v1/swaps/intents/*"],
    [`/v1/relay/${"x".repeat(24)}`, "/v1/relay/*"],
    ["/v1/intent/quote", "/v1/intent/quote"],
    ["/v1/relay/", "/v1/relay/"],
  ])("routes %s", (pathname, route) => {
    expect(routeOf(pathname)).toBe(route);
  });
});

describe("routeOf on every data API route the drift check knows", () => {
  const templates = Object.keys(TOOL_CONTRACT).map(key => key.split(" ")[1]);
  const routeOfTemplate = (template: string) => `/v1/be${template.replace(/:\w+/g, "*")}`;

  it("logs the route itself: static segments kept, each parameter masked, whatever shape its value takes", () => {
    expect(templates.some(path => path.includes(":"))).toBe(true);
    for (const template of templates) {
      // Hashes, addresses and the partner receiver are hex on the wire; anything else gets a short plain value,
      // the hardest to spot.
      const path = template.replace(/:(\w+)/g, (_, name: string) =>
        /hash|address|receiver/i.test(name) ? "0xabc123" : "x1",
      );
      expect(routeOf(`/v1/be${path}`), template).toBe(routeOfTemplate(template));
    }
  });

  it("knows every path the data API client builds, so none falls back to the masked guess", () => {
    const routes = new Set(templates.map(routeOfTemplate));
    // Every path-shaped literal in the client: a ${…} right after a slash is a path parameter.
    const literal = /[`"](\/(?:[\w-]+|\$\{\w+\})(?:\/(?:[\w-]+|\$\{\w+\}))*)/g;
    const source = readFileSync(new URL("./sodaxApi.ts", import.meta.url), "utf8");
    const built = [...source.matchAll(literal)].map(match => match[1]);
    expect(built.length).toBeGreaterThan(20);
    for (const each of built) expect(routes, each).toContain(routeOf(`/v1/be${each.replace(/\$\{\w+\}/g, "x1")}`));
  });
});
