/**
 * `sodax_get_balance` against live chains through the SDK's public RPCs: `pnpm test:contract`.
 * Reads only; nothing is signed or sent.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { BalanceResult } from "../services/swap/balance.js";
import { callTool } from "./__fixtures__/swapClient.js";

const DEAD = "0x000000000000000000000000000000000000dEaD";
// Not a dependency here: the copy the SDK runs on.
const { Keypair } = createRequire(createRequire(import.meta.url).resolve("@sodax/sdk"))("@stellar/stellar-sdk");

async function balance(args: Record<string, unknown>) {
  const { isError, out } = await callTool<BalanceResult & { error?: { code: string } }>("sodax_get_balance", args);
  expect(isError ? out.error?.code : "ok").toBe("ok");
  return out;
}

describe("sodax_get_balance against live chains", () => {
  it("reads 0x…dEaD's ETH and USDC on Arbitrum", async () => {
    const out = await balance({ chain: "arbitrum", address: DEAD, token: "USDC" });
    expect(BigInt(out.native.baseUnits)).toBeGreaterThan(0n);
    expect(BigInt(out.token?.baseUnits ?? 0)).toBeGreaterThan(0n);
  });

  it("reads Hedera's native balance at 8 decimals, as the SDK scales it", async () => {
    // The treasury (0.0.2) holds billions of HBAR; unscaled weibars would read 1e10 times more than all 50B.
    const out = await balance({ chain: "hedera", address: "0x0000000000000000000000000000000000000002" });
    expect(out.native.symbol).toBe("HBAR");
    expect(Number(out.native.amount)).toBeGreaterThan(1);
    expect(Number(out.native.amount)).toBeLessThan(50_000_000_000);
  });

  it("says a Stellar account that was never funded doesn't exist yet", async () => {
    const out = await balance({ chain: "stellar", address: Keypair.random().publicKey(), token: "USDC" });
    expect(out).toMatchObject({ accountExists: false, native: { baseUnits: "0" }, token: { baseUnits: "0" } });
  });

  it("reads 0 USDC and trustline false for a funded Stellar account without a USDC trustline", async () => {
    // SODAX's Stellar issuer: funded, and it holds no trustlines.
    const out = await balance({
      chain: "stellar",
      address: "GDYUTHY75A7WUZJQDPOP66FB32BOYGZRXHWTWO4Q6LQTANT5X3V5HNFA",
      token: "USDC",
    });
    expect(out).toMatchObject({ trustline: false, token: { symbol: "USDC", baseUnits: "0" } });
    expect(out.accountExists).toBeUndefined();
  });

  it.each([
    ["sui", `0x${"0".repeat(63)}1`],
    ["solana", "11111111111111111111111111111112"],
  ])("reads a %s address through the SDK", async (chain, address) => {
    const out = await balance({ chain, address });
    expect(out.native.baseUnits).toMatch(/^\d+$/);
  });
});
