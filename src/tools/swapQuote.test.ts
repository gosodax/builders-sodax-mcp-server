import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SODAX_SWAPS_BASE_URL } from "../constants.js";
import { setFallbackRequestContext } from "../services/requestContext.js";
import { clearCache } from "../services/sodaxApi.js";
import { catalogFetch, fixtureCatalog, fixtureText } from "../services/swap/__fixtures__/catalog.js";
import { checkRecipient } from "../services/swap/destination.js";
import { clearQuoteCache, getCachedQuote } from "../services/swap/quoteCache.js";
import { clearSwapCatalogCache, findToken } from "../services/swap/tokens.js";
import { callQuote as quote } from "./__fixtures__/swapClient.js";

const USER = "0x000000000000000000000000000000000000dEaD";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SONIC_USDC = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";
const DEADLINE = "1793001289";
// The clock the deadline check reads: DEADLINE is exactly the default 15 minutes ahead.
const NOW = (Number(DEADLINE) - 900) * 1000;
const ASSET_MANAGER = "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3";
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const approveData = (spender: string, amount: bigint | string) =>
  `0x095ea7b3${word(spender)}${word(BigInt(amount).toString(16))}`;
const catalog = fixtureCatalog();

const USDC_TO_SONIC = { fromChain: "0xa4b1.arbitrum", fromToken: ARB_USDC, toChain: "sonic", toToken: SONIC_USDC };

interface SwapsStub {
  /** Replaces the recorded chain config. */
  configs?: string;
  quote?: () => Response;
  deadline?: string;
  valid?: boolean;
  resetTx?: boolean;
  /** Overrides on what the stub builds, to play an upstream that builds the wrong thing. */
  intent?: Record<string, string>;
  swapValue?: string;
  approveData?: string;
  resetData?: string;
}

/** Serves the catalog plus the Swaps API routes; records each Swaps API call by path. */
function stubSwaps(stub: SwapsStub = {}) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const serveCatalog = catalogFetch(undefined, stub.configs);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(`${SODAX_SWAPS_BASE_URL}/`) || url.endsWith("/tokens")) return serveCatalog(input, init);
    const path = url.slice(SODAX_SWAPS_BASE_URL.length);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/quote") return stub.quote?.() ?? Response.json({ quotedAmount: "4991887" });
    if (path.startsWith("/deadline?")) return Response.json({ deadline: stub.deadline ?? DEADLINE });
    if (path === "/allowance/check") return Response.json({ valid: stub.valid ?? false });
    if (path === "/approve") {
      const approve = { from: USER, to: body.inputToken, value: "0" };
      return Response.json({
        tx: { ...approve, data: stub.approveData ?? approveData(ASSET_MANAGER, body.inputAmount) },
        ...(stub.resetTx && { resetTx: { ...approve, data: stub.resetData ?? approveData(ASSET_MANAGER, 0n) } }),
      });
    }
    if (path === "/intents") {
      // Like the live API: the intent's input is net of the partner fee, and its tokens are hub assets.
      const fee = body.partnerFee ? (BigInt(body.inputAmount) * BigInt(body.partnerFee.percentage)) / 10_000n : 0n;
      const src = findToken(catalog, body.srcChainKey, body.inputToken);
      const dst = findToken(catalog, body.dstChainKey, body.outputToken);
      const intent = {
        inputToken: src?.hubAsset,
        outputToken: dst?.hubAsset,
        inputAmount: String(BigInt(body.inputAmount) - fee),
        minOutputAmount: body.minOutputAmount,
        deadline: body.deadline,
        dstAddress: body.dstAddress,
        intentId: "1",
        ...stub.intent,
      };
      const value = stub.swapValue ?? (src?.isNative ? body.inputAmount : "0");
      const tx = { from: USER, to: ASSET_MANAGER, value, data: "0xabcd" };
      return Response.json({ tx, intent, relayData: { address: USER, payload: "0x01" } });
    }
    throw new Error(`unexpected Swaps API call ${path}`);
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearSwapCatalogCache();
  clearCache();
  clearQuoteCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setFallbackRequestContext({});
});

describe("sodax_swap_quote", () => {
  it("returns a price only without fromAddress, and builds nothing", async () => {
    const calls = stubSwaps();
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5" });
    expect(out).toMatchObject({
      status: "price_only",
      missing: ["fromAddress"],
      from: { symbol: "USDC", amount: "5", chain: { key: "0xa4b1.arbitrum" } },
      to: { symbol: "USDC", expectedAmount: "4.991887", minimumAmount: "4.941968" },
      slippageBps: 100,
    });
    expect(out.nextStep).toContain("call sodax_swap_quote again with fromAddress");
    expect(calls).toEqual([
      {
        path: "/quote",
        body: {
          tokenSrc: ARB_USDC,
          tokenSrcChainKey: "0xa4b1.arbitrum",
          tokenDst: SONIC_USDC,
          tokenDstChainKey: "sonic",
          amount: "5000000",
          quoteType: "exact_input",
        },
      },
    ]);
  });

  it("builds approve + swap, with the floored minimum, the deadline and a batch, and caches the quote", async () => {
    const calls = stubSwaps();
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5", fromAddress: USER });
    expect(out).toMatchObject({
      status: "ready",
      fromAddress: USER,
      toAddress: USER,
      expiresAt: new Date(Number(DEADLINE) * 1000).toISOString(),
      checks: { balance: "not_checked", recipient: "not_needed" },
      steps: [
        { kind: "approve", chainId: 42161, tx: { to: ARB_USDC } },
        { kind: "swap", chainId: 42161, tx: { to: ASSET_MANAGER } },
      ],
      batch: {
        replaces: ["approve", "swap"],
        method: "wallet_sendCalls",
        params: [{ version: "2.0.0", chainId: "0xa4b1", from: USER, atomicRequired: true }],
      },
    });
    expect(out.batch?.params[0].calls).toEqual([
      { to: ARB_USDC, value: "0x0", data: approveData(ASSET_MANAGER, 5000000n) },
      { to: ASSET_MANAGER, value: "0x0", data: "0xabcd" },
    ]);
    const intents = calls.find(call => call.path === "/intents");
    expect(intents?.body).toMatchObject({
      inputAmount: "5000000",
      minOutputAmount: "4941968",
      deadline: DEADLINE,
      allowPartialFill: false,
      srcAddress: USER,
      dstAddress: USER,
    });
    expect(calls.find(call => call.path.startsWith("/deadline"))?.path).toBe("/deadline?offsetSeconds=900");
    expect(getCachedQuote(String(out.quoteId))).toMatchObject({
      minOutputAmount: 4941968n,
      relayData: { payload: "0x01" },
    });
    expect(out.nextStep).toContain(`on Sonic (at least 4.941968) at ${USER}`);
    expect(out.nextStep).toContain("don't send the swap step or the batch");
  });

  it("skips the approve when the allowance is already enough (a native token)", async () => {
    const calls = stubSwaps({ valid: true });
    const { out } = await quote({ ...USDC_TO_SONIC, fromToken: "native", amount: "0.01", fromAddress: USER });
    expect(out.steps?.map(step => step.kind)).toEqual(["swap"]);
    expect(out.steps?.[0].tx.value).toBe("0x2386f26fc10000");
    expect(out.batch).toBeUndefined();
    expect(calls.map(call => call.path)).not.toContain("/approve");
  });

  it("puts a reset first, on its own, outside the batch", async () => {
    stubSwaps({ resetTx: true });
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5", fromAddress: USER });
    expect(out.steps?.map(step => step.kind)).toEqual(["reset_approve", "approve", "swap"]);
    expect(out.batch?.replaces).toEqual(["approve", "swap"]);
  });

  it.each<[string, SwapsStub]>([
    ["a lower minimum", { intent: { minOutputAmount: "1" } }],
    ["another recipient", { intent: { dstAddress: `0x${"1".repeat(40)}` } }],
    ["another output token", { intent: { outputToken: `0x${"2".repeat(40)}` } }],
    ["a bigger input", { intent: { inputAmount: "5000001" } }],
    ["value on a token swap", { swapValue: "1" }],
    ["an approval for another spender", { approveData: approveData(`0x${"3".repeat(40)}`, 5000000n) }],
    ["an unlimited approval", { approveData: approveData(ASSET_MANAGER, 2n ** 256n - 1n) }],
    ["a reset that isn't to zero", { resetTx: true, resetData: approveData(ASSET_MANAGER, 1n) }],
  ])("refuses a built swap with %s", async (_case, stub) => {
    stubSwaps(stub);
    const { isError, out } = await quote({ ...USDC_TO_SONIC, amount: "5", fromAddress: USER });
    expect(isError).toBe(true);
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("refuses a native swap that sends less than the amount", async () => {
    stubSwaps({ valid: true, swapValue: "1" });
    const { out } = await quote({ ...USDC_TO_SONIC, fromToken: "native", amount: "0.01", fromAddress: USER });
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("sends to an explicit recipient and names it to the user", async () => {
    const other = `0x${"4".repeat(40)}`;
    const calls = stubSwaps();
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5", fromAddress: USER, toAddress: other });
    expect(out).toMatchObject({ status: "ready", fromAddress: USER, toAddress: other });
    expect(calls.find(call => call.path === "/intents")?.body).toMatchObject({ srcAddress: USER, dstAddress: other });
    expect(out.nextStep).toContain(`at ${other}`);
  });

  it("builds for a non-EVM recipient", async () => {
    const recipient = `0x${"ab".repeat(32)}`;
    const calls = stubSwaps();
    const { out } = await quote({
      ...USDC_TO_SONIC,
      toChain: "sui",
      toToken: "native",
      amount: "5",
      fromAddress: USER,
      toAddress: recipient,
    });
    expect(out).toMatchObject({ status: "ready", toAddress: recipient, checks: { recipient: "not_needed" } });
    expect(calls.find(call => call.path === "/intents")?.body?.dstAddress).toBe(recipient);
  });

  it("reports a chain the config doesn't describe as unavailable, before any quote", async () => {
    const configs = JSON.parse(fixtureText("chain-configs.json"));
    delete configs.sonic.chain;
    const calls = stubSwaps({ configs: JSON.stringify(configs) });
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5" });
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  it("refuses a deadline that isn't the one asked for", async () => {
    stubSwaps({ deadline: "0" });
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5", fromAddress: USER });
    expect(out.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("sends the connection's partner fee on the quote and the intent, and shows it", async () => {
    setFallbackRequestContext({ partnerFee: { address: USER, bps: 25 } });
    const calls = stubSwaps();
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5", fromAddress: USER });
    expect(out.partnerFee).toEqual({ bps: 25, amount: "0.0125", symbol: "USDC" });
    expect(out.nextStep).toContain("send 5 USDC on Arbitrum, including a 0.0125 USDC partner fee,");
    for (const path of ["/quote", "/intents"]) {
      expect(calls.find(call => call.path === path)?.body?.partnerFee).toEqual({ address: USER, percentage: 25 });
    }
  });

  it.each([
    ["a withdraw-only token sent", { fromToken: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40" }, "RESTRICTED_TOKEN"],
    ["a non-EVM source", { fromChain: "sui", fromToken: "native" }, "UNSUPPORTED_SOURCE"],
    ["an amount with a comma", { amount: "1,000" }, "INVALID_AMOUNT"],
    ["an ambiguous token", { toToken: "USD" }, "UNKNOWN_TOKEN"],
    ["a bad sender", { fromAddress: "0x1234" }, "INVALID_ADDRESS"],
    ["a bad EVM recipient", { fromAddress: USER, toAddress: "0x1234" }, "INVALID_ADDRESS"],
    [
      "a recipient that isn't an address",
      { toChain: "sui", toToken: "native", fromAddress: USER, toAddress: "not an address" },
      "INVALID_ADDRESS",
    ],
  ])("refuses %s before asking for a quote", async (_case, args, code) => {
    const calls = stubSwaps();
    const { isError, out } = await quote({ ...USDC_TO_SONIC, amount: "5", ...args });
    expect(isError).toBe(true);
    expect(out.error.code).toBe(code);
    expect(calls).toEqual([]);
  });

  it.each([{ slippageBps: 0 }, { slippageBps: 501 }, { deadlineMinutes: 4 }, { deadlineMinutes: 61 }])(
    "rejects %o instead of clamping it",
    async bounds => {
      const calls = stubSwaps();
      const { isError } = await quote({ ...USDC_TO_SONIC, amount: "5", ...bounds });
      expect(isError).toBe(true);
      expect(calls).toEqual([]);
    },
  );

  it("asks for toAddress when the destination isn't EVM", async () => {
    stubSwaps();
    const { out } = await quote({
      ...USDC_TO_SONIC,
      toChain: "sui",
      toToken: "native",
      amount: "5",
      fromAddress: USER,
    });
    expect(out).toMatchObject({ status: "price_only", missing: ["toAddress"] });
    expect(out.nextStep).toContain("toAddress (their address on Sui)");
  });

  it.each([
    [() => Response.json({ message: "Input amount too low", code: -23 }, { status: 422 }), { code: "AMOUNT_TOO_LOW" }],
    [
      () => new Response("", { status: 429, headers: { "Retry-After": "7" } }),
      { code: "RATE_LIMITED", retryAfterSec: 7 },
    ],
    [() => new Response("", { status: 429 }), { code: "RATE_LIMITED", retryAfterSec: 60 }],
    [() => new Response("", { status: 401 }), { code: "API_KEY_REQUIRED" }],
    [() => new Response("", { status: 403 }), { code: "API_KEY_REQUIRED" }],
    [
      () => Response.json({ message: "unsupported token_src\nfor src chain" }, { status: 400 }),
      { code: "SWAP_REJECTED", status: 400, reason: "unsupported token_src for src chain" },
    ],
    [() => new Response("", { status: 502 }), { code: "UPSTREAM_UNAVAILABLE" }],
    [() => new Response("", { status: 404 }), { code: "UPSTREAM_UNAVAILABLE" }],
    [() => Response.json({ quotedAmount: 5 }), { code: "UPSTREAM_UNAVAILABLE" }],
    [() => Response.json({ quotedAmount: "0" }), { code: "AMOUNT_TOO_LOW" }],
  ])("maps a quote response to an error the agent can act on (%#)", async (response, error) => {
    stubSwaps({ quote: response });
    const { isError, out } = await quote({ ...USDC_TO_SONIC, amount: "5" });
    expect(isError).toBe(true);
    expect(out.error).toMatchObject(error);
  });

  it("passes on a plain upstream reason only, never markup", async () => {
    stubSwaps({ quote: () => new Response("<html><h1>400 Bad Request</h1></html>", { status: 400 }) });
    const { out } = await quote({ ...USDC_TO_SONIC, amount: "5" });
    expect(out.error).toMatchObject({ code: "SWAP_REJECTED", status: 400 });
    expect(out.error).not.toHaveProperty("reason");
  });
});

describe("checkRecipient", () => {
  it("refuses NEAR and Stellar recipients until it can check them", async () => {
    await expect(checkRecipient("NEAR")).rejects.toMatchObject({ code: "UNSUPPORTED_CHAIN" });
    await expect(checkRecipient("STELLAR")).rejects.toMatchObject({ code: "UNSUPPORTED_CHAIN" });
    await expect(checkRecipient("EVM")).resolves.toBe("not_needed");
  });
});
