/**
 * Human units ↔ base units, strictly: "1,000" or "1e6" from an agent must fail,
 * not move the wrong amount. Fractions are never rounded.
 */

import { ActionError } from "./errors.js";

const AMOUNT = /^\d+(\.\d+)?$/;
const MAX_UINT256 = 2n ** 256n - 1n;

export function parseUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  const [whole, fraction = ""] = text.split(".");
  if (!AMOUNT.test(text) || fraction.length > decimals) {
    throw new ActionError(
      "INVALID_AMOUNT",
      `Give the amount as a plain decimal with at most ${decimals} digits after the point.`,
    );
  }
  const base = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (base === 0n || base > MAX_UINT256) {
    throw new ActionError("INVALID_AMOUNT", "The amount must be more than zero and fit in 256 bits.");
  }
  return base;
}

export function formatUnits(base: bigint, decimals: number): string {
  const digits = base.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
