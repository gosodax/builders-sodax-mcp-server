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
async function wrappedTool(key: string | undefined, result: unknown, module: "swap" | "api" = "swap") {
  vi.resetModules();
  vi.stubEnv("POSTHOG_API_KEY", key ?? "");
  const { withAnalytics } = await import("./analytics.js");
  const { registerAppTool } = await import("./toolRegistry.js");
  const tools: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const server = { tool: (name: string, ...rest: unknown[]) => (tools[name] = rest.at(-1) as never) };
  withAnalytics(server as never);
  registerAppTool(server as never, module, "test_tool", "A tool.", {}, {}, (async () => result) as never);
  await tools.test_tool();
  return capture.mock.calls.at(-1)?.[0]?.properties as Record<string, unknown> | undefined;
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
