import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { spokeAssetManagerAbi } from "@sodax/sdk";
import { spokeChainConfig } from "@sodax/types";
import { type Hex, encodeFunctionData, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwapStep } from "../../src/services/swap/quote.js";
import { sendSteps, stepMismatch, track, wallets } from "./swapCanary.js";

// A throwaway key: every RPC call below goes to the fake in `fakeRpc`, nothing leaves the process.
const ACCOUNT = privateKeyToAccount(`0x${"1".repeat(64)}`);
const ARBITRUM = () => wallets(ACCOUNT)[0];
const { assetManager: ASSET_MANAGER } = spokeChainConfig["0xa4b1.arbitrum"].addresses;
const USDC = spokeChainConfig["0xa4b1.arbitrum"].supportedTokens.USDC.address;
const AMOUNT = 5_000_000n;

type Answer =
  | { result: unknown }
  | { error: { code: number; message: string }; status?: number }
  | { text: string; status: number }
  | "hang";

/**
 * Answers viem's JSON-RPC calls by method, through the global fetch its http transport uses. Each method
 * takes its answers in order, the last one repeating. Returns the methods called.
 */
function fakeRpc(answers: Record<string, Answer[]>): string[] {
  const methods: string[] = [];
  const queues = new Map(Object.entries(answers).map(([method, queue]) => [method, [...queue]]));
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { id, method } = JSON.parse(String(init.body));
    methods.push(method);
    const queue = queues.get(method) ?? [{ error: { code: -32601, message: `the test doesn't answer ${method}` } }];
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) as Answer;
    if (answer === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    if ("text" in answer) return new Response(answer.text, { status: answer.status });
    const { status = 200, ...body } = answer as { status?: number };
    return Response.json({ jsonrpc: "2.0", id, ...body }, { status });
  });
  return methods;
}

// What prepare and sign need on Arbitrum, with eth_fillTransaction unsupported so viem estimates the gas.
const CHAIN: Record<string, Answer[]> = {
  eth_chainId: [{ result: "0xa4b1" }],
  eth_getTransactionCount: [{ result: "0x7" }],
  eth_getBlockByNumber: [{ result: { number: "0x1", hash: `0x${"ab".repeat(32)}`, baseFeePerGas: "0x1" } }],
  eth_maxPriorityFeePerGas: [{ result: "0x1" }],
  eth_fillTransaction: [{ error: { code: -32601, message: "the method eth_fillTransaction does not exist" } }],
  eth_estimateGas: [{ result: "0x5208" }],
};
const REVERTED: Answer = { error: { code: 3, message: "execution reverted: ERC20: insufficient allowance" } };
const FOUND: Answer = { result: { hash: `0x${"cd".repeat(32)}` } };
const NOT_FOUND: Answer = { result: null };
const REFUSED: Answer = { error: { code: -32000, message: "insufficient funds for gas * price + value" } };
// Each of these can come after the node took the swap, so none of them may stop it being tracked.
const OUTCOME_UNKNOWN: [string, Answer][] = [
  ["a JSON-RPC error with HTTP 200", { error: { code: -32603, message: "internal error" } }],
  ["a JSON-RPC error inside a 503", { error: { code: -32603, message: "upstream timed out" }, status: 503 }],
  ['"already known"', { error: { code: -32000, message: "already known" } }],
  ['"nonce too low"', { error: { code: -32000, message: "nonce too low" } }],
  ["a timeout", "hang"],
  ["a plain-text 502", { text: "Bad Gateway", status: 502 }],
];
const SEND_ERRORS: [string, Answer][] = [...OUTCOME_UNKNOWN, ["a refusal", REFUSED]];

// Encoded with the SDK's ABI, so the script's own fragment is checked against it.
const depositData = (token: Hex = USDC, amount = AMOUNT) =>
  encodeFunctionData({
    abi: spokeAssetManagerAbi,
    functionName: "transfer",
    args: [token, ACCOUNT.address, amount, "0x1234"],
  });
const step = (kind: SwapStep["kind"], tx: Partial<SwapStep["tx"]> = {}, chainId = 42161): SwapStep => ({
  kind,
  chainId,
  tx: { from: ACCOUNT.address, to: ASSET_MANAGER, data: depositData(), value: "0x0", ...tx },
});
const swap = (tx: Partial<SwapStep["tx"]> = {}, chainId?: number) => step("swap", tx, chainId);
const approveData = (spender: Hex = ASSET_MANAGER, amount = AMOUNT) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
const approve = (tx: Partial<SwapStep["tx"]> = {}, kind: SwapStep["kind"] = "approve") =>
  step(kind, { to: USDC, data: approveData(), ...tx });
const QUOTE = { steps: [swap()] } as never;

/** Runs fake time until the promise settles; returns how much passed. */
async function settle(promise: Promise<unknown>): Promise<number> {
  const start = Date.now();
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; !done && i < 2_000; i++) await vi.advanceTimersByTimeAsync(1_000);
  return Date.now() - start;
}

let logs: string[];
beforeEach(() => {
  vi.useFakeTimers();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendSteps", () => {
  it("returns the swap's hash once the node takes it, without looking it up", async () => {
    const methods = fakeRpc({ ...CHAIN, eth_sendRawTransaction: [{ result: `0x${"cd".repeat(32)}` }] });
    const sent = sendSteps(ARBITRUM(), QUOTE);
    await settle(sent);
    await expect(sent).resolves.toMatch(/^0x[0-9a-f]{64}$/);
    expect(methods).not.toContain("eth_getTransactionByHash");
  });

  it.each(SEND_ERRORS)("after %s, tracks the swap a node has", async (_case, answer) => {
    const methods = fakeRpc({
      ...CHAIN,
      eth_sendRawTransaction: [answer],
      eth_getTransactionByHash: [NOT_FOUND, FOUND],
    });
    const sent = sendSteps(ARBITRUM(), QUOTE);
    await settle(sent);
    const hash = await sent;
    expect(logs).toContain(`[setup] swap: ${hash}`);
    expect(methods.filter(method => method === "eth_getTransactionByHash")).toHaveLength(2);
  });

  it.each(OUTCOME_UNKNOWN)("after %s, tracks the swap even when no node has it", async (_case, answer) => {
    const methods = fakeRpc({ ...CHAIN, eth_sendRawTransaction: [answer], eth_getTransactionByHash: [NOT_FOUND] });
    const sent = sendSteps(ARBITRUM(), QUOTE);
    await settle(sent);
    await expect(sent).resolves.toMatch(/^0x[0-9a-f]{64}$/);
    expect(methods.filter(method => method === "eth_getTransactionByHash")).toHaveLength(7);
    expect(logs).toContain("[setup] send outcome unknown; tracking anyway");
  });

  it.each<[string, Answer, number]>([
    ["answered at once", NOT_FOUND, 30_000],
    // 7 tries of 4 s each, none retried, and the 6 waits between them.
    ["that time out", "hang", 58_000],
  ])("fails after a refusal when lookups %s don't find the swap", async (_case, lookup, time) => {
    const methods = fakeRpc({ ...CHAIN, eth_sendRawTransaction: [REFUSED], eth_getTransactionByHash: [lookup] });
    const sent = sendSteps(ARBITRUM(), QUOTE);
    const elapsed = await settle(sent);
    await expect(sent).rejects.toThrow("the node refused the swap and no node had it");
    expect(methods.filter(method => method === "eth_getTransactionByHash")).toHaveLength(7);
    expect(elapsed).toBe(time);
  });

  it.each<[string, Record<string, Answer[]>]>([
    ["estimate", { eth_estimateGas: [REVERTED, { result: "0x5208" }] }],
    ["fill", { eth_fillTransaction: [REVERTED, ...CHAIN.eth_fillTransaction] }],
  ])("prepares the swap again when its gas %s reverts on a node that lags", async (_case, lagging) => {
    const methods = fakeRpc({ ...CHAIN, ...lagging, eth_sendRawTransaction: [{ result: `0x${"cd".repeat(32)}` }] });
    const sent = sendSteps(ARBITRUM(), QUOTE);
    await settle(sent);
    await expect(sent).resolves.toMatch(/^0x/);
    expect(methods).toContain("eth_sendRawTransaction");
  });

  it("gives up after 3 reverted estimates, having sent nothing", async () => {
    const methods = fakeRpc({ ...CHAIN, eth_estimateGas: [REVERTED] });
    const sent = sendSteps(ARBITRUM(), QUOTE);
    await settle(sent);
    await expect(sent).rejects.toThrow(/reverted/);
    expect(methods.filter(method => method === "eth_estimateGas")).toHaveLength(3);
    expect(methods).not.toContain("eth_sendRawTransaction");
  });
});

describe("stepMismatch", () => {
  it.each<[string, SwapStep[]]>([
    ["the swap alone", [swap()]],
    ["an approve, then the swap", [approve(), swap()]],
    [
      "a reset to 0, an approve, then the swap",
      [approve({ data: approveData(ASSET_MANAGER, 0n) }, "reset_approve"), approve(), swap()],
    ],
  ])("accepts %s", (_case, steps) => {
    expect(stepMismatch(steps, ARBITRUM(), AMOUNT)).toBeUndefined();
  });

  it.each<[string, SwapStep[], string]>([
    ["no steps", [], "steps: one swap, last"],
    ["no swap", [approve()], "steps: one swap, last"],
    ["a step after the swap", [swap(), approve()], "steps: one swap, last"],
    ["two swaps", [swap(), swap()], "steps: one swap, last"],
    ["a step on Base", [swap({}, 8453)], "step 1 (swap) chainId"],
    ["ETH sent with the swap", [swap({ value: "0x1" })], "step 1 (swap) tx.value"],
    ["ETH sent with the approve", [approve({ value: "0x1" }), swap()], "step 1 (approve) tx.value"],
    ["a swap into another contract", [swap({ to: USDC })], "step 1 (swap) tx.to"],
    [
      "a deposit of more than the amount",
      [approve(), swap({ data: depositData(USDC, AMOUNT + 1n) })],
      "step 2 (swap) tx.data: not transfer(USDC, 5000000)",
    ],
    [
      "a deposit of another token",
      [swap({ data: depositData(ASSET_MANAGER) })],
      "step 1 (swap) tx.data: not transfer(USDC, 5000000)",
    ],
    ["a swap that isn't a deposit", [swap({ data: "0x1234" })], "step 1 (swap) tx.data: not transfer(USDC, 5000000)"],
    ["an approve on another token", [approve({ to: ASSET_MANAGER }), swap()], "step 1 (approve) tx.to"],
    [
      "another spender",
      [approve({ data: approveData(ACCOUNT.address) }), swap()],
      "step 1 (approve) tx.data: not approve(asset manager, 5000000)",
    ],
    [
      "more than the amount",
      [approve({ data: approveData(ASSET_MANAGER, AMOUNT + 1n) }), swap()],
      "step 1 (approve) tx.data: not approve(asset manager, 5000000)",
    ],
    [
      "a reset that isn't to 0",
      [approve({}, "reset_approve"), approve(), swap()],
      "step 1 (reset_approve) tx.data: not approve(asset manager, 0)",
    ],
  ])("names the field for %s", (_case, steps, field) => {
    expect(stepMismatch(steps, ARBITRUM(), AMOUNT)).toBe(field);
  });
});

describe("track", () => {
  const ENV = {} as never;
  const quote = (expiresInMs: number) =>
    ({
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      afterSend: { tool: "sodax_swap_track", args: { quoteId: "q-1" }, needs: "txHash" },
    }) as never;
  const reply = (out: object, isError = false) => ({ isError, out: out as never });

  it("retries a call that throws (client timeout, rate limit), printing no error message", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, "Request timed out https://rpc.example/key"))
      .mockRejectedValueOnce(new StreamableHTTPError(429, "Too many requests from 10.0.0.1"))
      .mockResolvedValueOnce(reply({ status: "queued", retryAfterSec: 5 }))
      .mockResolvedValueOnce(reply({ status: "solved" }));
    const tracked = track(ENV, quote(60_000), "0xabc", call);
    await settle(tracked);
    await expect(tracked).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledTimes(4);
    expect(call).toHaveBeenCalledWith(ENV, "sodax_swap_track", { quoteId: "q-1", txHash: "0xabc" });
    expect(logs).toEqual(expect.arrayContaining(["[setup] McpError -32001, retrying", "[setup] Error 429, retrying"]));
    expect(logs.join("\n")).not.toMatch(/rpc\.example|10\.0\.0\.1/);
  });

  it("still fails on a tool error that isn't retryable", async () => {
    const call = vi.fn().mockResolvedValue(reply({ error: { code: "INTERNAL" } }, true));
    const tracked = track(ENV, quote(60_000), "0xabc", call);
    await settle(tracked);
    await expect(tracked).rejects.toThrow("error INTERNAL");
  });

  it("waits no longer than the deadline, whatever retryAfterSec says", async () => {
    const call = vi.fn().mockResolvedValue(reply({ status: "in_progress", stage: "solving", retryAfterSec: 3_600 }));
    // The deadline is 5 minutes past the expiry: 20 s from now.
    const tracked = track(ENV, quote(20_000 - 5 * 60_000), "0xabc", call);
    const elapsed = await settle(tracked);
    await expect(tracked).rejects.toThrow("not solved by 5 minutes past the quote's expiry");
    expect(elapsed).toBeLessThanOrEqual(21_000);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
