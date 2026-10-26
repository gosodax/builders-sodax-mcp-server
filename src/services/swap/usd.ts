/**
 * What a swap is worth in USD, from the solver's oracle (cached, keyless). Only ever a warning to
 * the agent, never a reason to refuse: the user's signature is the real check. Anything doubtful
 * (no price, an old price, a slow or failing oracle) is `null`.
 */

import { sameHex } from "../../constants.js";
import type { OraclePrice } from "../../types.js";
import { bounded } from "../sodax.js";
import { getSolverOracle } from "../solver.js";
import { HUB_RELAY_ID } from "./sourceTx.js";

const MAX_PRICE_AGE_MS = 60 * 60 * 1000;
// The quote waits on this next to the Swaps API quote; it mustn't hold the quote up.
const ORACLE_WAIT_MS = 3_000;
// After a failure, quotes skip the oracle for a while instead of each waiting out the timeout.
const SKIP_AFTER_FAILURE_MS = 30_000;

let skipUntil = 0;

async function oraclePrices(): Promise<OraclePrice[] | null> {
  if (Date.now() < skipUntil) return null;
  try {
    return await bounded(getSolverOracle, ORACLE_WAIT_MS);
  } catch {
    skipUntil = Date.now() + SKIP_AFTER_FAILURE_MS;
    return null;
  }
}

/** The USD value of `amount` (token units, a plain decimal) of the token with this hub asset. */
export async function usdValue(hubAsset: string, amount: string): Promise<number | null> {
  const prices = await oraclePrices();
  // The oracle prices hub assets by the hub's relay id, as a string; updatedAt is in ms.
  // Entries are only checked to be an array upstream; a malformed one is skipped, never a failed quote.
  const price = prices?.find(
    p =>
      typeof p?.address === "string" &&
      typeof p.priceUsd === "number" &&
      p.chainId === String(HUB_RELAY_ID) &&
      sameHex(p.address, hubAsset),
  );
  // Written so a missing or NaN timestamp counts as stale.
  const fresh = price !== undefined && Date.now() - price.updatedAt <= MAX_PRICE_AGE_MS;
  const value = fresh ? Number(amount) * price.priceUsd : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

export function clearUsdBackoff(): void {
  skipUntil = 0;
}
