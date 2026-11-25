import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SODAX_BRIDGE_BASE_URL } from "../../constants.js";
import { ActionError } from "../swap/errors.js";
import {
  type BridgeRequest,
  buildBridge,
  buildBridgeApproval,
  checkBridgeAllowance,
  getBridgeTxStatus,
  submitBridgeTx,
} from "./bridgeApi.js";

const USER = "0x1111111111111111111111111111111111111111";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const HUB_WALLET = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"ab".repeat(32)}`;

const request: BridgeRequest = {
  srcChainKey: "0xa4b1.arbitrum",
  dstChainKey: "0x2105.base",
  inputToken: USDC_ARB,
  outputToken: USDC_BASE,
  inputAmount: 5_000_000n,
  srcAddress: USER,
  dstAddress: USER,
};

const evmTx = (data: string) => ({ from: USER, to: USDC_ARB, value: "0", data });
const relayData = { address: HUB_WALLET, payload: "0xdeadbeef" };

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

/** Answers the next call with `body` as JSON. */
function answer(body: unknown, init: ResponseInit = { status: 200 }): void {
  fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(body), init));
}

function sent(): { url: string; method?: string; body: unknown } {
  const [input, init] = fetchSpy.mock.calls[0] ?? [];
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  return { url: String(input), method: init?.method, body };
}

async function failure(promise: Promise<unknown>): Promise<ActionError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("build routes", () => {
  it("sends the amount as a decimal string and no partner fee when the connection has none", async () => {
    answer({ valid: true });
    expect(await checkBridgeAllowance(request)).toBe(true);
    expect(sent()).toEqual({
      url: `${SODAX_BRIDGE_BASE_URL}/allowance/check`,
      method: "POST",
      body: {
        srcChainKey: "0xa4b1.arbitrum",
        dstChainKey: "0x2105.base",
        inputToken: USDC_ARB,
        outputToken: USDC_BASE,
        inputAmount: "5000000",
        srcAddress: USER,
        dstAddress: USER,
      },
    });
  });

  it("sends the connection's partner fee in basis points as the wire's percentage", async () => {
    answer({ valid: false });
    await checkBridgeAllowance({ ...request, partnerFee: { address: HUB_WALLET, bps: 25 } });
    expect(sent().body).toMatchObject({ partnerFee: { address: HUB_WALLET, percentage: 25 } });
  });

  it("returns the approve tx, and the reset first when the token needs one", async () => {
    answer({ tx: evmTx("0x095ea7b3") });
    expect(await buildBridgeApproval(request)).toEqual({ tx: evmTx("0x095ea7b3") });
    answer({ tx: evmTx("0x095ea7b3"), resetTx: evmTx("0x095ea7b4") });
    expect(await buildBridgeApproval(request)).toEqual({ tx: evmTx("0x095ea7b3"), resetTx: evmTx("0x095ea7b4") });
  });

  it.each([
    ["a non-EVM approve", { tx: { instructions: [] } }],
    ["a reset that isn't an EVM tx", { tx: evmTx("0x095ea7b3"), resetTx: "0x" }],
  ])("refuses %s", async (_, body) => {
    answer(body);
    expect((await failure(buildBridgeApproval(request))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("returns the deposit tx unparsed and the relay data", async () => {
    answer({ tx: evmTx("0x"), relayData });
    expect(await buildBridge(request)).toEqual({ tx: evmTx("0x"), relayData });
    expect(sent().url).toBe(`${SODAX_BRIDGE_BASE_URL}/intents`);
  });

  it.each([
    ["no relay data", { tx: evmTx("0x") }],
    ["a relay address that isn't one", { tx: evmTx("0x"), relayData: { ...relayData, address: "0x12" } }],
    ["a payload that isn't hex", { tx: evmTx("0x"), relayData: { ...relayData, payload: "zz" } }],
  ])("refuses a build with %s", async (_, body) => {
    answer(body);
    expect((await failure(buildBridge(request))).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});

describe("submit-tx", () => {
  const body = { txHash: TX_HASH, srcChainKey: "0xa4b1.arbitrum", walletAddress: USER, relayData };

  it.each(["inserted", "duplicate"] as const)("returns %s", async status => {
    answer({ success: true, data: { status, message: "ok" } });
    expect(await submitBridgeTx(body)).toBe(status);
    expect(sent()).toMatchObject({ url: `${SODAX_BRIDGE_BASE_URL}/submit-tx`, method: "POST", body });
  });

  it("fails when the service doesn't accept it", async () => {
    answer({ success: false });
    expect((await failure(submitBridgeTx(body))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("says when the tx was already submitted with other relay data", async () => {
    answer({ message: "already submitted with a different payload" }, { status: 409 });
    const error = await failure(submitBridgeTx(body));
    expect(error.code).toBe("BRIDGE_REJECTED");
    expect(error.details).toEqual({ reason: "submitted_differently" });
  });
});

describe("submit-tx status", () => {
  const record = {
    txHash: TX_HASH,
    srcChainKey: "0xa4b1.arbitrum",
    status: "executed",
    processingAttempts: 2,
    failureReason: "upstream text",
    userMessage: "upstream text",
    result: { dstIntentTxHash: TX_HASH, packetData: {} },
  };

  it("asks by tx hash and source chain, and keeps only what tracking acts on", async () => {
    answer({ success: true, data: record });
    expect(await getBridgeTxStatus(TX_HASH, "0xa4b1.arbitrum")).toEqual({
      status: "executed",
      result: { dstIntentTxHash: TX_HASH },
    });
    expect(sent()).toMatchObject({
      url: `${SODAX_BRIDGE_BASE_URL}/submit-tx/status?txHash=${TX_HASH}&srcChainKey=0xa4b1.arbitrum`,
      method: "GET",
    });
  });

  it("drops a destination hash that doesn't look like one", async () => {
    answer({ success: true, data: { ...record, result: { dstIntentTxHash: "<script>" } } });
    expect((await getBridgeTxStatus(TX_HASH, "0xa4b1.arbitrum"))?.result).toEqual({});
  });

  it.each([
    ["a 404", () => answer({ message: "No submit-bridge-tx found" }, { status: 404 })],
    ["success: false", () => answer({ success: false, data: record })],
  ])("is null on %s", async (_, respond) => {
    respond();
    expect(await getBridgeTxStatus(TX_HASH, "0xa4b1.arbitrum")).toBeNull();
  });
});

describe("failures", () => {
  it.each([
    [401, { message: "Invalid API key" }, "API_KEY_REQUIRED"],
    [403, { message: "This organisation is suspended" }, "API_KEY_REQUIRED"],
    [400, { message: "inputToken is not usable as a source" }, "BRIDGE_REJECTED"],
    [400, { message: "Amount must be greater than 0", code: "VALIDATION_FAILED" }, "BRIDGE_REJECTED"],
    [404, { message: "Token not supported" }, "BRIDGE_REJECTED"],
    [502, { message: "allowance check failed", code: "ALLOWANCE_CHECK_FAILED" }, "UPSTREAM_UNAVAILABLE"],
    [503, { message: "Bitcoin bridges are unavailable" }, "UPSTREAM_UNAVAILABLE"],
    [504, { message: "timed out" }, "UPSTREAM_UNAVAILABLE"],
  ])("maps a %i (%j) to %s", async (status, body, code) => {
    answer(body, { status });
    expect((await failure(buildBridge(request))).code).toBe(code);
  });

  it("says when the key lacks the bridge scope, and that a new key fixes it", async () => {
    answer({ message: "API key is missing the bridge:write scope" }, { status: 403 });
    const error = await failure(buildBridge(request));
    expect(error.code).toBe("API_KEY_REQUIRED");
    expect(error.details).toEqual({ reason: "missing_bridge_scope" });
    expect(error.nextStep).toContain("https://portal.sodax.com");
  });

  it("waits out Retry-After on a 429", async () => {
    answer({ message: "Too Many Requests" }, { status: 429, headers: { "Retry-After": "42" } });
    const error = await failure(buildBridge(request));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.details).toEqual({ retryAfterSec: 42 });
  });

  it("points a build the wallet can't make at the read of its balance", async () => {
    answer({ message: "createBridgeIntent failed", code: "INTENT_CREATION_FAILED" }, { status: 422 });
    const error = await failure(buildBridge(request));
    expect(error.code).toBe("BRIDGE_REJECTED");
    expect(error.details).toEqual({ reason: "wallet_cannot_build" });
    expect(error.hint).toEqual({
      balance: { chain: "0xa4b1.arbitrum", address: USER, token: USDC_ARB, for: "bridge" },
    });
  });

  it("is unavailable when the service can't be reached", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await failure(checkBridgeAllowance(request))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("never passes upstream text to the agent", async () => {
    answer({ message: "secret upstream detail", code: "VALIDATION_FAILED" }, { status: 400 });
    const error = await failure(buildBridge(request));
    expect(JSON.stringify({ message: error.message, nextStep: error.nextStep, details: error.details })).not.toContain(
      "secret upstream detail",
    );
  });
});
