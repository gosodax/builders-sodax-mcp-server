import { EvmHubProvider } from "@sodax/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBridge } from "../services/bridge/store.js";
import {
  approveCalldata,
  bridgeLimit,
  initSodax,
  sdkBridge,
  swapContractFor,
  walletBalance,
} from "../services/sodax.js";
import { bridgeClient, mcpClient } from "./__fixtures__/swapClient.js";

// The hub reads are scripted; the builds, rebuilds and checks run on the real SDK.
vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return {
    ...actual,
    bridgeLimit: vi.fn(),
    walletBalance: vi.fn(),
    sdkBridge: vi.fn(actual.sdkBridge),
  };
});

const actual = await vi.importActual<typeof import("../services/sodax.js")>("../services/sodax.js");
await initSodax();

const USER = "0x1234567890123456789012345678901234567890";
const HUB_WALLET = `0x${"c".repeat(40)}`;
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARB_TO_BASE = { fromChain: "arbitrum", fromToken: "USDC", toChain: "base", toToken: "USDC", amount: "5" };

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  vi.spyOn(EvmHubProvider.prototype, "getUserHubWalletAddress").mockResolvedValue(HUB_WALLET);
  vi.mocked(bridgeLimit).mockResolvedValue({ amount: 10n ** 12n, decimals: 6, type: "DEPOSIT_LIMIT" });
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(sdkBridge).mockImplementation(actual.sdkBridge);
});

/** The Bridge API answering as an honest one does: the SDK's own build, and the allowance given. */
function bridgeApi({ allowance = true }: { allowance?: boolean } = {}) {
  fetchSpy.mockImplementation(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.endsWith("/allowance/check")) return Response.json({ valid: allowance });
    if (url.endsWith("/approve")) {
      // From Sonic the user's hub wallet pulls the token; from a spoke, the asset manager the deposit calls.
      const spender = body.srcChainKey === "sonic" ? HUB_WALLET : (swapContractFor(body.srcChainKey) as string);
      const tx = { from: body.srcAddress, to: body.inputToken, value: "0" };
      return Response.json({
        tx: { ...tx, data: approveCalldata(body.inputToken, spender, BigInt(body.inputAmount)) },
      });
    }
    if (url.endsWith("/intents")) {
      const { tx, relayData } = await actual.sdkBridge({
        srcChainKey: body.srcChainKey,
        srcAddress: body.srcAddress,
        srcToken: body.inputToken,
        amount: BigInt(body.inputAmount),
        dstChainKey: body.dstChainKey,
        dstToken: body.outputToken,
        recipient: body.dstAddress,
      });
      const { value, ...rest } = tx as { value: bigint };
      return Response.json({ tx: { ...rest, value: value.toString() }, relayData });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function call(name: string, args: Record<string, unknown>) {
  const client = await bridgeClient();
  // Listed first, so the client checks every result, errors included, against the tool's output schema.
  await client.listTools();
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return { isError: result.isError, out: result.structuredContent as ToolResult };
}

/** The fields these tests read off any bridge or token tool result. */
type ToolResult = Record<string, unknown> & {
  status: string;
  nextStep: string;
  terminal: boolean;
  nextAction: Record<string, unknown>;
  error: Record<string, unknown> & { code: string; message: string };
  bridgeId: string;
  steps: { kind: string; approves?: { spender: string } }[];
};

describe("the bridge profile", () => {
  it("serves the bridge tools with the token lookup and balance read, and nothing else", async () => {
    const client = await bridgeClient();
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      "sodax_bridge_prepare",
      "sodax_bridge_preview",
      "sodax_bridge_submit_and_track",
      "sodax_bridge_tokens",
      "sodax_get_balance",
      "sodax_resolve_token",
    ]);
  });

  it("registers the shared tools once next to the swap tools", async () => {
    const client = await mcpClient({ builder: false, swap: true, bridge: true });
    const names = (await client.listTools()).tools.map(tool => tool.name);
    await client.close();
    expect(names.filter(name => name === "sodax_resolve_token")).toHaveLength(1);
    expect(names).toContain("sodax_swap_prepare");
    expect(names).toContain("sodax_bridge_prepare");
  });
});

describe("sodax_bridge_prepare", () => {
  it("returns the approve and the bridge, to confirm, then send, then track by bridgeId", async () => {
    bridgeApi({ allowance: false });
    const { isError, out } = await call("sodax_bridge_prepare", { ...ARB_TO_BASE, fromAddress: USER });
    expect(isError).toBeFalsy();
    expect(out).toMatchObject({
      status: "ready",
      from: { symbol: "USDC", amount: "5", address: ARB_USDC },
      to: { symbol: "USDC", amount: "5", address: BASE_USDC },
      toAddress: USER,
      terminal: false,
    });
    expect(out.steps.map((step: { kind: string }) => step.kind)).toEqual(["approve", "bridge"]);
    expect(out.steps[0]?.approves?.spender.toLowerCase()).toBe(
      (swapContractFor("0xa4b1.arbitrum") as string).toLowerCase(),
    );
    expect(out.nextAction).toMatchObject({
      type: "confirm",
      summary: {
        kind: "bridge",
        bridgeId: out.bridgeId,
        send: { amount: "5", symbol: "USDC", chain: "0xa4b1.arbitrum" },
        receive: { amount: "5", symbol: "USDC", chain: "0x2105.base" },
        recipient: USER,
        approve: { amount: "5", symbol: "USDC" },
      },
      next: {
        type: "execute",
        chain: "0xa4b1.arbitrum",
        stepsAt: "steps",
        batchAt: "batch",
        waitFor: "receipt_success",
        afterSend: {
          type: "call_tool",
          tool: "sodax_bridge_submit_and_track",
          args: { bridgeId: out.bridgeId, chain: "0xa4b1.arbitrum" },
          on: "broadcast",
          needs: ["txHash"],
        },
      },
    });
    // A wallet that batches sends the approve and the bridge as one atomic wallet_sendCalls.
    expect(out.batch).toEqual({
      replaces: ["approve", "bridge"],
      method: "wallet_sendCalls",
      params: [{ version: "2.0.0", chainId: "0xa4b1", from: USER, atomicRequired: true }],
    });
    expect(out.nextStep).toContain("wallet_sendCalls with the batch's params");
    // Kept for track: the relay data checked, and what the recipient gets.
    expect(getBridge(out.bridgeId)).toMatchObject({ delivered: 5_000_000n, relayData: { address: HUB_WALLET } });
  });

  it("offers no batch without an approve, nor from Sonic, where track checks the deposit as the tx itself", async () => {
    bridgeApi();
    const approved = await call("sodax_bridge_prepare", { ...ARB_TO_BASE, fromAddress: USER });
    expect(approved.out.steps.map(step => step.kind)).toEqual(["bridge"]);
    expect(approved.out.batch).toBeUndefined();
    expect(approved.out.nextAction).not.toHaveProperty("next.batchAt");
    bridgeApi({ allowance: false });
    const fromSonic = await call("sodax_bridge_prepare", { ...ARB_TO_BASE, fromChain: "sonic", fromAddress: USER });
    expect(fromSonic.isError).toBeFalsy();
    expect(fromSonic.out.steps.map(step => step.kind)).toEqual(["approve", "bridge"]);
    expect(fromSonic.out.batch).toBeUndefined();
    expect(fromSonic.out.nextStep).not.toContain("wallet_sendCalls");
  });

  it("asks for the sender's wallet before building anything", async () => {
    const { isError, out } = await call("sodax_bridge_prepare", { ...ARB_TO_BASE, toToken: "USDC" });
    expect(isError).toBe(true);
    expect(out.error).toMatchObject({ code: "INVALID_ADDRESS", missing: ["fromAddress"] });
    expect(out.nextAction).toMatchObject({ type: "provide", fields: [{ name: "fromAddress" }] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("offers the tokens a pair without a shared vault does bridge to", async () => {
    const { out } = await call("sodax_bridge_prepare", { ...ARB_TO_BASE, toToken: "native", fromAddress: USER });
    expect(out.error).toMatchObject({ code: "BRIDGE_REJECTED", reason: "not_bridgeable" });
    expect(out.nextAction).toMatchObject({
      type: "choose",
      field: "toToken",
      options: [{ label: "USDC on Base", args: { toChain: "0x2105.base", toToken: BASE_USDC } }],
    });
  });

  it("asks for a smaller amount above what the route takes now", async () => {
    vi.mocked(bridgeLimit).mockResolvedValue({ amount: 4_000_000n, decimals: 6, type: "WITHDRAWAL_LIMIT" });
    const { out } = await call("sodax_bridge_prepare", { ...ARB_TO_BASE, fromAddress: USER });
    expect(out.error).toMatchObject({ code: "BRIDGE_REJECTED", reason: "above_limit", maxAmount: "4" });
    expect(out.nextAction).toMatchObject({ type: "provide", fields: [{ name: "amount" }] });
  });

  it("names the chains a bridge can start from, worded for a bridge", async () => {
    const { out } = await call("sodax_bridge_prepare", {
      ...ARB_TO_BASE,
      fromChain: "bitcoin",
      fromToken: "native",
      fromAddress: USER,
    });
    expect(out.error.code).toBe("UNSUPPORTED_SOURCE");
    expect(out.error.message).toBe("Bridges from Bitcoin aren't supported here.");
    expect(out.nextStep).not.toMatch(/\bswap/);
  });

  it("refuses a build the Bridge API made for another recipient", async () => {
    fetchSpy.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith("/allowance/check")) return Response.json({ valid: true });
      const { tx, relayData } = await actual.sdkBridge({
        srcChainKey: "0xa4b1.arbitrum",
        srcAddress: USER,
        srcToken: ARB_USDC,
        amount: 5_000_000n,
        dstChainKey: "0x2105.base",
        dstToken: BASE_USDC,
        recipient: `0x${"9".repeat(40)}`,
      });
      const { value, ...rest } = tx as { value: bigint };
      return Response.json({ tx: { ...rest, value: value.toString() }, relayData });
    });
    const { out } = await call("sodax_bridge_prepare", { ...ARB_TO_BASE, fromAddress: USER });
    expect(out.error.code).toBe("BRIDGE_MISMATCH");
    expect(out.terminal).toBe(true);
  });
});

describe("sodax_bridge_tokens", () => {
  it("lists each token that bridges, with the token it arrives as, reading nothing", async () => {
    const { out } = await call("sodax_bridge_tokens", { fromChain: "arbitrum", toChain: "base" });
    expect(out.status).toBe("ok");
    const pairs = out.pairs as { from: { symbol: string }; to: { symbol: string; address: string } }[];
    expect(pairs).toContainEqual({
      from: { symbol: "USDC", address: ARB_USDC },
      to: { symbol: "USDC", address: BASE_USDC },
    });
    // tBTC is withdraw-only on Arbitrum: it arrives there, it doesn't leave.
    expect(pairs.map(pair => pair.from.symbol)).not.toContain("tBTC");
    expect(out).toMatchObject({
      terminal: false,
      nextAction: {
        type: "choose",
        field: "pair",
        options: expect.arrayContaining([
          {
            label: "USDC to USDC",
            args: { fromChain: "0xa4b1.arbitrum", fromToken: ARB_USDC, toChain: "0x2105.base", toToken: BASE_USDC },
          },
        ]),
        next: {
          type: "provide",
          fields: [{ name: "amount" }],
          next: { type: "call_tool", tool: "sodax_bridge_preview", sameArgs: true },
        },
      },
    });
    expect(out.nextStep).toContain("sodax_bridge_preview");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bridgeLimit).not.toHaveBeenCalled();
  });

  it("names the chains a bridge can start from", async () => {
    const { out } = await call("sodax_bridge_tokens", { fromChain: "bitcoin", toChain: "sonic" });
    expect(out.error).toMatchObject({ code: "UNSUPPORTED_SOURCE", field: "fromChain" });
  });
});

describe("sodax_bridge_preview", () => {
  it("shows what would arrive and the most the route takes, building and holding nothing", async () => {
    vi.mocked(bridgeLimit).mockResolvedValue({ amount: 2_500_000_000n, decimals: 6, type: "DEPOSIT_LIMIT" });
    const { out } = await call("sodax_bridge_preview", ARB_TO_BASE);
    expect(out).toMatchObject({
      status: "preview",
      from: { amount: "5", symbol: "USDC" },
      to: { amount: "5", symbol: "USDC" },
      maxAmount: "2500",
      prepareNeeds: ["fromAddress"],
      terminal: false,
      nextAction: {
        type: "provide",
        fields: [{ name: "fromAddress" }],
        next: { type: "call_tool", tool: "sodax_bridge_prepare", sameArgs: true },
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks for the recipient too when a side isn't EVM", async () => {
    vi.mocked(bridgeLimit).mockResolvedValue({ amount: 10n ** 12n, decimals: 9, type: "DEPOSIT_LIMIT" });
    const { out } = await call("sodax_bridge_preview", {
      fromChain: "solana",
      fromToken: "native",
      toChain: "sonic",
      toToken: "SOL",
      amount: "0.01",
    });
    expect(out.prepareNeeds).toEqual(["fromAddress", "toAddress"]);
  });

  it("refuses an amount above the route's limit, as prepare does", async () => {
    vi.mocked(bridgeLimit).mockResolvedValue({ amount: 1_000_000n, decimals: 6, type: "DEPOSIT_LIMIT" });
    const { out } = await call("sodax_bridge_preview", ARB_TO_BASE);
    expect(out.error).toMatchObject({ code: "BRIDGE_REJECTED", reason: "above_limit", maxAmount: "1" });
  });
});

describe("the token tools, for a bridge", () => {
  it("find a token the swap list doesn't have", async () => {
    const { out } = await call("sodax_resolve_token", { chain: "base", query: "USDT", for: "bridge" });
    expect(out).toMatchObject({ status: "resolved", token: { symbol: "USDT" } });
    expect(out.nextStep).toContain("sodax_bridge_prepare");
  });

  it("read its balance", async () => {
    vi.mocked(walletBalance).mockResolvedValue(1_500_000n);
    const { out } = await call("sodax_get_balance", { chain: "base", address: USER, token: "USDT", for: "bridge" });
    expect(out).toMatchObject({ status: "ok", token: { symbol: "USDT", amount: "1.5" } });
  });

  it("look in the bridge's list by default when the swap tools aren't served", async () => {
    const { out } = await call("sodax_resolve_token", { chain: "base", query: "USDT" });
    expect(out).toMatchObject({ status: "resolved", token: { symbol: "USDT" } });
  });

  it("fail in a bridge's words, next to the swap tools too", async () => {
    const client = await mcpClient({ builder: false, swap: true, bridge: true });
    const lookup = (purpose: string) =>
      client.callTool({ name: "sodax_resolve_token", arguments: { chain: "nowhere", query: "USDC", for: purpose } });
    const forBridge = (await lookup("bridge")).structuredContent as ToolResult;
    const forSwap = (await lookup("swap")).structuredContent as ToolResult;
    await client.close();
    expect(forBridge.error).toMatchObject({
      code: "UNSUPPORTED_CHAIN",
      message: expect.stringContaining("bridge chain"),
    });
    expect(forSwap.error).toMatchObject({ code: "UNSUPPORTED_CHAIN", message: expect.stringContaining("swap chain") });
  });
});
