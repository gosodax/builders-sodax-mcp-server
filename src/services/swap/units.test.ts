import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "./units.js";

describe("parseUnits", () => {
  it.each([
    ["0.5", 6, 500000n],
    [" 1 ", 6, 1000000n],
    ["1.000000", 6, 1000000n],
    ["0.000001", 6, 1n],
    ["5", 0, 5n],
    [(2n ** 256n - 1n).toString(), 0, 2n ** 256n - 1n],
  ])("%j at %i decimals → %s", (amount, decimals, expected) => {
    expect(parseUnits(amount, decimals)).toBe(expected);
  });

  it.each([
    ["1,000", 6],
    ["1e6", 6],
    [".5", 6],
    ["5.", 6],
    ["-1", 6],
    ["+1", 6],
    ["0", 6],
    ["0.0", 6],
    ["", 6],
    ["0x10", 6],
    ["1.0000001", 6],
    [(2n ** 256n).toString(), 0],
  ])("refuses %j at %i decimals", (amount, decimals) => {
    expect(() => parseUnits(amount, decimals)).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
  });
});

describe("formatUnits", () => {
  it.each([
    [1500000n, 6, "1.5"],
    [1n, 18, "0.000000000000000001"],
    [5n, 0, "5"],
    [1000000n, 6, "1"],
  ])("%s at %i decimals → %s", (base, decimals, expected) => {
    expect(formatUnits(base, decimals)).toBe(expected);
  });

  it("round-trips with parseUnits", () => {
    for (const amount of ["0.5", "123.456789", "1"]) expect(formatUnits(parseUnits(amount, 6), 6)).toBe(amount);
  });
});
