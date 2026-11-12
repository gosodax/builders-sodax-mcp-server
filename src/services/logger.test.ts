import { createRequire } from "node:module";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildLogger, errorName, logger, redact, redactErr } from "./logger.js";
import { runWithRequestContext } from "./requestContext.js";

describe("redactErr", () => {
  it("removes URLs from every field of an error, its own properties and cause included", () => {
    const cause = new Error("fetch https://rpc.example/KEY/cause failed");
    const error = Object.assign(new Error("HTTP request failed. URL: https://rpc.example/KEY"), {
      url: "https://rpc.example/KEY",
      metaMessages: ["Request body: {}", "URL: https://rpc.example/KEY"],
      cause,
    });
    const serialized = JSON.stringify(redactErr(error));
    expect(serialized).not.toContain("KEY");
    expect(serialized).toContain("HTTP request failed. URL: <url>");
  });

  it("leaves text without a URL alone, and stops at quotes", () => {
    expect(redact("no url here")).toBe("no url here");
    expect(redact("ratio 1:2 // a: b, see note.")).toBe("ratio 1:2 // a: b, see note.");
    expect(redact('{"u":"https://a.example/x","n":1}')).toBe('{"u":"<url>","n":1}');
  });

  it.each(["ws://rpc.example/KEY", "wss://rpc.example/KEY", "HTTPS://rpc.example/KEY", "rpc+wss://rpc.example/KEY"])(
    "removes a URL of any scheme (%s)",
    url => {
      expect(redact(`socket to ${url} closed`)).toBe("socket to <url> closed");
    },
  );

  it("removes a URL glued to a word or a digit", () => {
    expect(redact("key_https://rpc.example/KEY")).toBe("key_<url>");
    expect(redact("1https://rpc.example/KEY")).toBe("1<url>");
  });

  // A hostile RPC's response body reaches error messages; it must not stall the event loop.
  it("stays fast on a megabyte of scheme-like text with no URL", () => {
    const text = "a-".repeat(512 * 1024);
    const start = performance.now();
    expect(redact(text)).toBe(text);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("removes viem's request body (the user's address) and URL from a real viem error", () => {
    // viem as the SDK resolves it: the SDK's chain reads throw these.
    const require = createRequire(import.meta.url);
    const viem = createRequire(require.resolve("@sodax/sdk"))("viem") as typeof import("viem");
    const user = "0x1234567890abcdef1234567890abcdef12345678";
    const error = new viem.HttpRequestError({
      url: "https://rpc.example/KEY",
      body: { method: "eth_call", params: [{ from: user }] },
      details: "fetch failed",
    });
    const serialized = JSON.stringify(redactErr(error));
    expect(serialized).not.toContain("KEY");
    expect(serialized).not.toContain(user);
    expect(serialized).toContain("Request body: <redacted>");
    expect(serialized).toContain("HTTP request failed.");
  });

  it("removes the user's address from viem's contract and call errors, in text and in fields", () => {
    const require = createRequire(import.meta.url);
    const viem = createRequire(require.resolve("@sodax/sdk"))("viem") as typeof import("viem");
    const user = "0x1234567890abcdef1234567890abcdef12345678";
    const usdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const abi = [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const;
    const read = new viem.ContractFunctionExecutionError(new viem.BaseError("execution reverted"), {
      abi,
      functionName: "balanceOf",
      args: [user],
      contractAddress: usdc,
      sender: user,
    });
    const call = new viem.CallExecutionError(new viem.BaseError("reverted"), {
      account: user,
      to: usdc,
      data: `0x70a08231000000000000000000000000${user.slice(2)}`,
    });
    for (const error of [read, call]) {
      const serialized = JSON.stringify(redactErr(error));
      expect(serialized.toLowerCase()).not.toContain(user.slice(2));
      expect(serialized).toContain(usdc);
    }
  });

  it("removes a URL that is a property name, and the start of a key cut off mid-way", () => {
    expect(JSON.stringify(redactErr({ "https://rpc.example/KEY": 1 }))).not.toContain("KEY");
    expect(redact("echo: sodax_Ab3dEfGhIjKlMn")).toBe("echo: <key>");
  });

  it("keeps a stack frame's file path, so a stack still says where it failed", () => {
    const frame = "at track (file:///app/dist/services/swap/track.js:120:11)";
    expect(redact(frame)).toBe(frame);
  });

  it("removes a URL whose slashes are JSON-escaped", () => {
    expect(redact('{"u":"https:\\/\\/rpc.example\\/KEY"}')).toBe('{"u":"<url>"}');
  });

  it("removes SODAX keys and bearer tokens, and keeps tool names", () => {
    const key = "sodax_Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789-_";
    expect(redact(`key ${key} refused`)).toBe("key <key> refused");
    expect(redact("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer <key>");
    expect(redact("called sodax_get_supported_chains_for_everyone")).toBe(
      "called sodax_get_supported_chains_for_everyone",
    );
    const serialized = JSON.stringify(redactErr({ headers: { "x-api-key": "plain", apiKey: "plain" }, message: key }));
    expect(serialized).not.toContain("plain");
    expect(serialized).not.toContain(key);
  });

  it("removes a URL of many megabytes without running out of stack", () => {
    expect(redact(`at https://${"a".repeat(9 * 1024 * 1024)} end`)).toBe("at <url> end");
  });

  it("is the logger's serializer for err", () => {
    const serializers = (logger as unknown as Record<symbol, Record<string, unknown>>)[pino.symbols.serializersSym];
    expect(serializers.err).toBe(redactErr);
  });

  it("never throws: bigints, cycles, thrown strings and plain objects all come out without URLs", () => {
    const withBigint = Object.assign(new Error("call to HTTPS://rpc.example/KEY"), { amount: 10n });
    const circular: Record<string, unknown> = { message: "see https://rpc.example/KEY" };
    circular.self = circular;
    for (const thrown of [
      withBigint,
      circular,
      "request to https://rpc.example/KEY failed",
      { url: "https://x/KEY" },
    ]) {
      const serialized = JSON.stringify(redactErr(thrown));
      expect(serialized).not.toContain("KEY");
    }
    expect(redactErr(withBigint)).toMatchObject({ amount: "10" });
  });
});

describe("request id", () => {
  it("is on every record written inside a request context, and on none outside", () => {
    const lines: string[] = [];
    const log = buildLogger({ write: line => void lines.push(line) }, { level: "info" });
    runWithRequestContext({ requestId: "r1" }, () => log.info({ "gen_ai.tool.name": "x" }, "in"));
    log.info("out");
    const [inside, outside] = lines.map(line => JSON.parse(line));
    expect(inside).toMatchObject({ "request.id": "r1", "gen_ai.tool.name": "x", msg: "in" });
    expect(outside).not.toHaveProperty("request.id");
  });
});

describe("errorName", () => {
  it("takes a code-shaped cause, else the class name, never any text", () => {
    expect(errorName(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(
      "ECONNREFUSED",
    );
    expect(
      errorName(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })),
    ).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(
      errorName(Object.assign(new Error("rpc"), { cause: { code: "execution reverted: https://evil.example" } })),
    ).toBe("Error");
    expect(errorName(Object.assign(new Error("rpc"), { cause: { code: -32000 } }))).toBe("Error");
    expect(errorName("boom")).toBe("string");
  });
});
