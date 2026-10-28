/**
 * Human units ↔ base units, strictly: "1,000" or "1e6" from an agent must fail,
 * not move the wrong amount. Fractions are never rounded.
 */

import { ActionError } from "./errors.js";

export const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const MAX_UINT256 = 2n ** 256n - 1n;

const amountField = { field: "amount" };

export function parseUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  const [whole, fraction = ""] = text.split(".");
  if (!AMOUNT_PATTERN.test(text) || fraction.length > decimals) {
    throw new ActionError(
      "INVALID_AMOUNT",
      `Give the amount as a plain decimal, with no commas or units and at most ${decimals} digits after the point.`,
      { details: amountField },
    );
  }
  const base = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (base === 0n || base > MAX_UINT256) {
    throw new ActionError("INVALID_AMOUNT", "The amount must be more than zero and fit in 256 bits.", {
      details: amountField,
    });
  }
  return base;
}

/**
 * An amount sent as a JSON number, as the decimal it was written as. Only one with no exponent and at most
 * 15 significant digits is sure to read back exactly; any other may have lost digits, so it's refused.
 */
export function amountText(amount: string | number): string {
  if (typeof amount === "string") return amount;
  const text = String(amount);
  if (/e/i.test(text) || text.replace(/^-/, "").replace(".", "").replace(/^0+/, "").length > 15) {
    throw new ActionError(
      "INVALID_AMOUNT",
      'Give this amount as a string, e.g. "0.5": as a number it may not be exact.',
      {
        details: amountField,
        nextStep: "Call sodax_swap_quote again with amount as a string holding the user's exact amount.",
      },
    );
  }
  return text;
}

export function formatUnits(base: bigint, decimals: number): string {
  const digits = base.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
