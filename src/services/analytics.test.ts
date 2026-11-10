import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const constructed = vi.fn();
vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      constructed(...args);
    }
    capture = capture;
    shutdown = async () => undefined;
  },
}));

/** A fresh analytics module (it reads POSTHOG_API_KEY at load) and a tool wrapped by it. */
async function wrapTool(key: string | undefined, handler: () => Promise<unknown>, module: "swap" | "api" = "swap") {
  vi.resetModules();
  vi.stubEnv("POSTHOG_API_KEY", key ?? "");
  const { logger } = await import("./logger.js");
  const { getRequestContext } = await import("./requestContext.js");
  const { withAnalytics } = await import("./analytics.js");
  const { registerAppTool } = await import("./toolRegistry.js");
  const tools: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const server = { tool: (name: string, ...rest: unknown[]) => (tools[name] = rest.at(-1) as never) };
  withAnalytics(server as never);
  registerAppTool(server as never, module, "test_tool", "A tool.", {}, {}, handler as never);
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  return { call: () => tools.test_tool(), info, error, getRequestContext };
}

/** The wrapped tool called once: the PostHog event's properties. */
async function wrappedTool(key: string | undefined, result: unknown, module: "swap" | "api" = "swap") {
  const { call } = await wrapTool(key, async () => result, module);
  await call();
  return capture.mock.calls.at(-1)?.[0]?.properties as Record<string, unknown> | undefined;
}

// The secret is read at module load, so each test imports a fresh module.
async function loadHashClientIp(secret: string | undefined) {
  vi.resetModules();
  vi.stubEnv("POSTHOG_CLIENT_ID_SECRET", secret);
  return (await import("./analytics.js")).hashClientIp;
}

afterEach(() => {
  vi.unstubAllEnvs();
  capture.mockReset();
  constructed.mockReset();
});

describe("analytics", () => {
  it("counts a returned error as a failure, with its code and no message", async () => {
    const props = await wrappedTool("phc_test", {
      isError: true,
      structuredContent: { status: "error", error: { code: "UNKNOWN_TOKEN", message: "That token, USDX, …" } },
    });
    expect(props).toMatchObject({ success: false, error_code: "UNKNOWN_TOKEN", status: "error" });
    expect(JSON.stringify(props)).not.toContain("USDX");
  });

  it("sends a swap quote's status, quote id, chains and USD bucket, and nothing else of it", async () => {
    const props = await wrappedTool("phc_test", {
      structuredContent: {
        status: "ready",
        quoteId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
        from: { chain: { key: "0xa4b1.arbitrum" }, amount: "5", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
        to: { chain: { key: "sonic" }, expectedAmount: "4.99" },
        usdValue: "4321.00",
        fromAddress: "0x000000000000000000000000000000000000dEaD",
        steps: [{ tx: { data: "0xdeadbeef" } }],
      },
    });
    expect(props).toMatchObject({
      success: true,
      status: "ready",
      quote_id: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
      src_chain: "0xa4b1.arbitrum",
      dst_chain: "sonic",
      usd_bucket: "1k-10k",
    });
    expect(JSON.stringify(props)).not.toMatch(/dEaD|af88|deadbeef|4321|4\\.99/);
  });

  it("takes track's single chain as the source, and adds no swap fields to other tools", async () => {
    const track = await wrappedTool("phc_test", {
      structuredContent: { status: "queued", chain: { key: "0x2105.base" }, txHash: `0x${"ab".repeat(32)}` },
    });
    expect(track).toMatchObject({ status: "queued", src_chain: "0x2105.base" });
    expect(JSON.stringify(track)).not.toContain("abab");
    const builder = await wrappedTool(
      "phc_test",
      { structuredContent: { status: "ok", chain: { key: "sonic" } } },
      "api",
    );
    expect(builder).not.toHaveProperty("status");
    expect(builder).not.toHaveProperty("src_chain");
  });

  it("sends nothing without POSTHOG_API_KEY", async () => {
    await wrappedTool(undefined, { structuredContent: { status: "ok" } });
    expect(constructed).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("hashClientIp", () => {
  it("is an HMAC keyed by POSTHOG_CLIENT_ID_SECRET when set", async () => {
    const hashClientIp = await loadHashClientIp("test-secret");
    const expected = createHmac("sha256", "test-secret").update("sodax-mcp:203.0.113.7").digest("hex").slice(0, 16);

    expect(hashClientIp("203.0.113.7")).toBe(expected);
    expect(hashClientIp("203.0.113.7")).not.toBe(
      createHash("sha256").update("sodax-mcp:203.0.113.7").digest("hex").slice(0, 16),
    );
  });

  it("keeps the unkeyed salted hash when the secret is unset", async () => {
    const hashClientIp = await loadHashClientIp(undefined);

    expect(hashClientIp("203.0.113.7")).toBe(
      createHash("sha256").update("sodax-mcp:203.0.113.7").digest("hex").slice(0, 16),
    );
  });

  it("says whether the id is keyed, so only an HMAC reaches the logs", async () => {
    vi.resetModules();
    vi.stubEnv("POSTHOG_CLIENT_ID_SECRET", "test-secret");
    expect((await import("./analytics.js")).CLIENT_ID_KEYED).toBe(true);
    vi.resetModules();
    vi.stubEnv("POSTHOG_CLIENT_ID_SECRET", "");
    expect((await import("./analytics.js")).CLIENT_ID_KEYED).toBe(false);
  });

  it("maps the same IP to the same id and different IPs to different ids", async () => {
    const hashClientIp = await loadHashClientIp("test-secret");

    expect(hashClientIp("203.0.113.7")).toBe(hashClientIp("203.0.113.7"));
    expect(hashClientIp("203.0.113.7")).not.toBe(hashClientIp("203.0.113.8"));
  });
});

describe("tool call records", () => {
  it("logs one record per call with the outcome, and gives each call its own request id", async () => {
    const seen: (string | undefined)[] = [];
    const { call, info, getRequestContext } = await wrapTool(
      undefined,
      async () => {
        seen.push(getRequestContext().requestId);
        return { content: [], isError: true, structuredContent: { error: { code: "UNKNOWN_TOKEN" } } };
      },
      "api",
    );
    await call();
    await call();
    expect(info).toHaveBeenCalledWith(
      {
        "tool.name": "test_tool",
        "duration.ms": expect.any(Number),
        "tool.outcome": "error",
        "error.code": "UNKNOWN_TOKEN",
      },
      "Tool call",
    );
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it("keeps the request id an HTTP request already set", async () => {
    const seen: (string | undefined)[] = [];
    const { call, getRequestContext } = await wrapTool(
      undefined,
      async () => {
        seen.push(getRequestContext().requestId);
        return { content: [] };
      },
      "api",
    );
    const { runWithRequestContext } = await import("./requestContext.js");
    await runWithRequestContext({ requestId: "http-1" }, call);
    expect(seen).toEqual(["http-1"]);
  });

  it("logs a thrown error at error level with its class and frames, never its text", async () => {
    const { call, info, error } = await wrapTool(
      undefined,
      async () => {
        throw new TypeError("secret detail");
      },
      "api",
    );
    await expect(call()).rejects.toThrow("secret detail");
    expect(error).toHaveBeenCalledWith(
      {
        err: { type: "TypeError", stack: expect.stringMatching(/^ {4}at /) },
        "tool.name": "test_tool",
        "duration.ms": expect.any(Number),
        "tool.outcome": "error",
        "error.code": "TypeError",
      },
      "Tool call",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret detail");
    expect(info).not.toHaveBeenCalledWith(expect.anything(), "Tool call");
  });

  it("names the caller by a hash of its key, never the key, under a name the gateway doesn't redact", async () => {
    const { call, info } = await wrapTool(undefined, async () => ({ content: [] }), "api");
    const { runWithRequestContext } = await import("./requestContext.js");
    await runWithRequestContext({ apiKey: "sodax_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" }, call);
    const [record] = info.mock.calls.at(-1) as [Record<string, unknown>];
    expect(record["caller.key_hash"]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(record)).not.toMatch(/sodax_abc|api_key/);
  });

  it("adds the ids a swap is followed by, from the result and nothing else of it", async () => {
    const { call, info } = await wrapTool(undefined, async () => ({
      content: [],
      structuredContent: {
        status: "ready",
        quoteId: "q-1",
        txHash: "0xtx",
        hubTxHash: "0xhub",
        amount: "5",
        from: { chain: { key: "0xa4b1.arbitrum" } },
      },
    }));
    await call();
    const [record] = info.mock.calls.at(-1) as [Record<string, unknown>];
    expect(record).toMatchObject({
      "tool.name": "test_tool",
      "tool.outcome": "ok",
      "swap.status": "ready",
      "quote.id": "q-1",
      "tx.hash": "0xtx",
      "hub_tx.hash": "0xhub",
      "chain.key": "0xa4b1.arbitrum",
    });
    expect(JSON.stringify(record)).not.toContain("amount");
  });
});
