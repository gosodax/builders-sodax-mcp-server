import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSolverOracle } from "../solver.js";
import { clearUsdBackoff, usdValue } from "./usd.js";

vi.mock("../solver.js", () => ({ getSolverOracle: vi.fn() }));

const NOW = Date.parse("2026-10-27T12:00:00Z");
const HUB_USDC = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";
const price = (overrides: Record<string, unknown> = {}) => ({
  address: HUB_USDC.toLowerCase(),
  chainId: "146",
  symbol: "USDC",
  priceUsd: 0.9998,
  decimals: 6,
  updatedAt: NOW - 60_000,
  ...overrides,
});

beforeEach(() => clearUsdBackoff());

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(getSolverOracle).mockReset();
});

describe("usdValue", () => {
  it("prices the amount by the hub asset on the hub, whatever the address case", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.mocked(getSolverOracle).mockResolvedValue([price({ chainId: "1", priceUsd: 99 }), price()]);
    await expect(usdValue(HUB_USDC, "12.5")).resolves.toBeCloseTo(12.4975);
  });

  it.each([
    ["no price for the asset", [price({ address: "0x0000000000000000000000000000000000000001" })]],
    ["a price older than an hour", [price({ updatedAt: NOW - 61 * 60_000 })]],
    ["a price that isn't a number", [price({ priceUsd: Number.NaN })]],
  ])("is null for %s", async (_case, prices) => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.mocked(getSolverOracle).mockResolvedValue(prices as never);
    await expect(usdValue(HUB_USDC, "1")).resolves.toBeNull();
  });

  it("is null when the oracle fails", async () => {
    vi.mocked(getSolverOracle).mockRejectedValue(new Error("down"));
    await expect(usdValue(HUB_USDC, "1")).resolves.toBeNull();
  });

  it("doesn't wait more than 3 seconds for the oracle", async () => {
    vi.useFakeTimers();
    vi.mocked(getSolverOracle).mockReturnValue(new Promise(() => {}));
    const pending = usdValue(HUB_USDC, "1");
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBeNull();
  });

  it("skips the oracle for 30 seconds after it failed, then asks again", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.mocked(getSolverOracle).mockRejectedValueOnce(new Error("down")).mockResolvedValue([price()]);
    await expect(usdValue(HUB_USDC, "1")).resolves.toBeNull();
    await expect(usdValue(HUB_USDC, "1")).resolves.toBeNull();
    expect(getSolverOracle).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 30_000);
    await expect(usdValue(HUB_USDC, "1")).resolves.toBeCloseTo(0.9998);
  });

  it("skips malformed oracle entries instead of failing", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.mocked(getSolverOracle).mockResolvedValue([null, { ...price(), address: 123 }, price()] as never);
    await expect(usdValue(HUB_USDC, "1")).resolves.toBeCloseTo(0.9998);
  });
});
