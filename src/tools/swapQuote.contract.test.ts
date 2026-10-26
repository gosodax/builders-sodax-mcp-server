/**
 * `sodax_swap_quote` against the live Swaps API: `pnpm test:contract` (canary by default,
 * `SODAX_ENV=production` for production). Quotes for 0x…dEaD; nothing is signed or sent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseApiKey, setFallbackRequestContext } from "../services/requestContext.js";
import { getAllChainsConfigs } from "../services/sodaxApi.js";
import { getCachedQuote } from "../services/swap/quoteCache.js";
import { formatUnits } from "../services/swap/units.js";
import { callQuote } from "./__fixtures__/swapClient.js";

const USER = "0x000000000000000000000000000000000000dEaD";
const ARB_USDC = { fromChain: "0xa4b1.arbitrum", fromToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" };
const TO_BASE_USDC = { toChain: "0x2105.base", toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };

// Set SODAX_API_KEY once the Swaps API enforces keys.
const apiKey = parseApiKey(process.env.SODAX_API_KEY);

describe("sodax_swap_quote against the live Swaps API", () => {
  beforeEach(() => {
    setFallbackRequestContext({ apiKey });
  });

  afterEach(() => {
    setFallbackRequestContext({});
  });

  it("builds approve + swap to the Arbitrum asset manager, with our minimum and deadline", async () => {
    const before = Date.now();
    const { out } = await callQuote({ ...ARB_USDC, ...TO_BASE_USDC, amount: "5", fromAddress: USER });
    expect(out.status).toBe("ready");
    expect(out.steps?.map(step => [step.kind, step.chainId])).toEqual([
      ["approve", 42161],
      ["swap", 42161],
    ]);
    const configs = (await getAllChainsConfigs()) as Record<string, { addresses: { assetManager: string } }>;
    expect(out.steps?.[1].tx.to.toLowerCase()).toBe(configs["0xa4b1.arbitrum"].addresses.assetManager.toLowerCase());
    const cached = getCachedQuote(String(out.quoteId));
    expect(out.to?.minimumAmount).toBe(formatUnits(BigInt(String(cached?.intent.minOutputAmount)), 6));
    const minutes = (Date.parse(String(out.expiresAt)) - before) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThan(16);
  });

  // Sonic's swap goes to the hub intents contract, which only the SDK config names: refused until then.
  it("refuses a swap from Sonic until its contract is known", async () => {
    const { out } = await callQuote({
      fromChain: "sonic",
      fromToken: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
      ...TO_BASE_USDC,
      amount: "5",
      fromAddress: USER,
    });
    expect(out.error.code).toBe("UNSUPPORTED_SOURCE");
  });

  it("needs no approve for native ETH, and sends the amount as the tx value", async () => {
    const { out } = await callQuote({
      ...ARB_USDC,
      fromToken: "native",
      ...TO_BASE_USDC,
      amount: "0.002",
      fromAddress: USER,
    });
    expect(out.steps?.map(step => step.kind)).toEqual(["swap"]);
    expect(out.steps?.[0].tx.value).toBe(`0x${(2n * 10n ** 15n).toString(16)}`);
  });

  it.each([
    ["Sui (hex)", { toChain: "sui", toToken: "native", toAddress: `0x${"ab".repeat(32)}` }],
    [
      "Solana (base58)",
      { toChain: "solana", toToken: "native", toAddress: "So11111111111111111111111111111111111111112" },
    ],
  ])("builds a swap to %s for the recipient given", async (_case, destination) => {
    const { out } = await callQuote({ ...ARB_USDC, ...destination, amount: "5", fromAddress: USER });
    expect(out.status).toBe("ready");
    expect(out.toAddress).toBe(destination.toAddress);
  });

  it("takes the partner fee from the amount sent, as the built intent confirms", async () => {
    const plain = await callQuote({ ...ARB_USDC, ...TO_BASE_USDC, amount: "100" });
    setFallbackRequestContext({ apiKey, partnerFee: { address: USER, bps: 100 } });
    const { out } = await callQuote({ ...ARB_USDC, ...TO_BASE_USDC, amount: "100", fromAddress: USER });
    expect(out.status).toBe("ready");
    expect(out.partnerFee).toEqual({ bps: 100, amount: "1", symbol: "USDC" });
    expect(Number(out.to?.expectedAmount)).toBeLessThan(Number(plain.out.to?.expectedAmount) - 0.9);
  });

  it.each([
    ["dust", { ...ARB_USDC, ...TO_BASE_USDC, amount: "0.000001" }, "AMOUNT_TOO_LOW"],
    [
      "tBTC sent",
      { ...ARB_USDC, fromToken: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40", ...TO_BASE_USDC, amount: "1" },
      "RESTRICTED_TOKEN",
    ],
    [
      "a Solana source",
      { fromChain: "solana", fromToken: "native", ...TO_BASE_USDC, amount: "1" },
      "UNSUPPORTED_SOURCE",
    ],
  ])("refuses %s", async (_case, args, code) => {
    const { out } = await callQuote(args);
    expect(out.error.code).toBe(code);
  });
});
