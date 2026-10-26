/**
 * `sodax_get_balance` against live chains through the SDK's public RPCs: `pnpm test:contract`.
 * Reads only; nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";
import type { BalanceResult } from "../services/swap/balance.js";
import { callTool } from "./__fixtures__/swapClient.js";

const DEAD = "0x000000000000000000000000000000000000dEaD";

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

  it.each([
    ["sui", `0x${"0".repeat(63)}1`],
    ["solana", "11111111111111111111111111111112"],
  ])("reads a %s address through the SDK", async (chain, address) => {
    const out = await balance({ chain, address });
    expect(out.native.baseUnits).toMatch(/^\d+$/);
  });
});
