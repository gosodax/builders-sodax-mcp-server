import { describe, expect, it } from "vitest";
import { BadResponseError, HttpError } from "./http.js";
import { InputError, classifyFailure, failedResult, failureOf, markFailure } from "./toolFailure.js";

/** How a data service hands a failure on: its own message, the cause kept. */
const wrapped = (cause: unknown) => new Error("Failed to fetch intent from SODAX API", { cause });

describe("classifyFailure", () => {
  it.each([
    [new HttpError("HTTP 404", 404), "UPSTREAM_NOT_FOUND"],
    [new HttpError("HTTP 429", 429), "UPSTREAM_RATE_LIMITED"],
    // Sent with the caller's key: their quota.
    [new HttpError("HTTP 429", 429, { keyed: true }), "RATE_LIMITED"],
    [new HttpError("HTTP 400", 400), "UPSTREAM_4XX"],
    [new HttpError("HTTP 503", 503), "UPSTREAM_5XX"],
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "UPSTREAM_TIMEOUT"],
    [
      new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }),
      "UPSTREAM_UNREACHABLE",
    ],
    // The socket dropped while the body was read.
    [
      new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }),
      "UPSTREAM_UNREACHABLE",
    ],
    [new BadResponseError("Empty response body"), "UPSTREAM_BAD_RESPONSE"],
    [new InputError("Invalid chainId"), "INVALID_INPUT"],
  ])("names %o by its cause, however deep the services wrapped it", (cause, code) => {
    expect(classifyFailure(cause)).toEqual({ code });
    expect(classifyFailure(wrapped(cause))).toEqual({ code });
    expect(classifyFailure(wrapped(wrapped(cause)))).toEqual({ code });
  });

  it("calls anything it can't explain a bug, and keeps the error for its stack", () => {
    // A SyntaxError too: the HTTP client turns an unparseable body into a BadResponseError, so this one is ours.
    // And a TypeError of our own, which no network error caused, even one carrying a Node argument error.
    const errors = [
      new RangeError("x"),
      new SyntaxError("x"),
      new TypeError("x is not a function"),
      new TypeError("bad", { cause: Object.assign(new Error("arg"), { code: "ERR_INVALID_ARG_TYPE" }) }),
      wrapped(new Error("x")),
      "a string",
      undefined,
    ];
    for (const error of errors) {
      expect(classifyFailure(error)).toEqual({ code: "INTERNAL", thrown: error });
    }
  });
});

describe("failedResult", () => {
  it("answers with the text a data tool always did, the code riding on the result object only", () => {
    const error = wrapped(new HttpError("HTTP 503", 503));
    const result = failedResult(error);
    expect(result).toEqual({
      content: [{ type: "text", text: "Error: Failed to fetch intent from SODAX API" }],
      isError: true,
    });
    expect(failureOf(result)).toEqual({ code: "UPSTREAM_5XX" });
    expect(JSON.stringify(result)).not.toContain("UPSTREAM");
  });

  it("takes the tool's own text when it has one", () => {
    const result = failedResult(new InputError("bad"), "Error: bad\n\nA hint.");
    expect(result.content).toEqual([{ type: "text", text: "Error: bad\n\nA hint." }]);
    expect(failureOf(result)).toEqual({ code: "INVALID_INPUT" });
  });
});

describe("failureOf", () => {
  it("knows only the results marked, and anything that isn't an object is none", () => {
    const marked = markFailure({ isError: true }, { code: "X" });
    expect(failureOf(marked)).toEqual({ code: "X" });
    for (const other of [{ isError: true }, null, undefined, "text", 1]) expect(failureOf(other)).toBeUndefined();
  });
});
