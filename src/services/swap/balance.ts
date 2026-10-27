/** `sodax_get_balance`: a wallet's native balance and, optionally, one token's, read through the SDK. */

import { recipientReady, walletBalance } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { TtlCache } from "../ttlCache.js";
import { ActionError } from "./errors.js";
import { checkAddress, resolveExactly, resolveSwapChain } from "./resolver.js";
import { chainRead } from "./source.js";
import { type SwapsApiToken, getSwapCatalog, nativeToken } from "./tokens.js";
import { formatUnits } from "./units.js";

export interface Holding {
  symbol: string;
  address: string;
  decimals: number;
  /** In token units, as a plain decimal. */
  amount: string;
  baseUnits: string;
}

export interface BalanceResult {
  status: "ok";
  chain: ChainInfo;
  address: string;
  /** On Stellar, the spendable XLM: the balance less the reserve the account must keep. */
  native: Holding;
  /** The token asked for; the native coin's holding when that's the one. */
  token?: Holding;
  /** False when the account doesn't exist on the chain yet (Stellar, NEAR): it holds nothing there. */
  accountExists?: false;
  /** False when the Stellar account has no trustline for the token: it holds none and can't receive it yet. */
  trustline?: false;
}

// A few seconds: an agent polling one wallet reads the chain once, and a top-up still shows soon.
// Bounded, since every address a caller passes is a new key.
const balances = new TtlCache(5_000, 10_000);

export function clearBalanceCache(): void {
  balances.clear();
}

export async function readBalances(input: { chain: string; address: string; token?: string }): Promise<BalanceResult> {
  const catalog = await getSwapCatalog();
  const chain = resolveSwapChain(catalog, input.chain);
  const chainType = catalog.chains[chain.key]?.type;
  const native = nativeToken(catalog, chain.key);
  if (!native)
    throw new ActionError("UPSTREAM_UNAVAILABLE", `The swap token list has no native token for ${chain.name}.`);
  const address = checkAddress(input.address, chain);
  const asked = input.token ? resolveExactly(catalog, chain.key, input.token).token : undefined;
  const token = asked?.isNative ? undefined : asked;
  // The SDK reads only BTC on Bitcoin, and would report any other token there as 0.
  if (token && chainType === "BITCOIN") {
    throw new ActionError("UNKNOWN_TOKEN", "Only the BTC balance can be read on Bitcoin.", {
      nextStep: "Ask for the BTC balance instead.",
    });
  }

  // Validated before any read; a failed read is CHAIN_UNAVAILABLE, never 0.
  const tokenUnits =
    token &&
    chainRead(chain, "balance", async () => {
      const units = await cachedBalance(chain.key, address, token);
      // Only a native read may say the account is missing.
      if (units === null) throw new Error("no balance for the token");
      return units;
    });
  // Settled together: a failed token read counts only once the account is known to exist.
  const [nativeRead] = await Promise.allSettled([
    chainRead(chain, "balance", () => cachedBalance(chain.key, address, native)),
    tokenUnits,
  ]);
  if (nativeRead.status === "rejected") throw nativeRead.reason;
  const base = { status: "ok" as const, chain, address };
  if (nativeRead.value === null) {
    // An account that doesn't exist holds nothing; Stellar fails its token reads rather than say so.
    return { ...base, native: holding(native, 0n), ...(asked && { token: holding(asked, 0n) }), accountExists: false };
  }
  const held = holding(native, nativeRead.value);
  if (!token || !tokenUnits) return { ...base, native: held, ...(asked && { token: held }) };
  try {
    return { ...base, native: held, token: holding(token, await tokenUnits) };
  } catch (error) {
    // Stellar's read fails when the account has no trustline for the token (0n: any trustline at all).
    const noTrustline =
      chainType === "STELLAR" &&
      !(await chainRead(chain, "trustline", () => recipientReady("STELLAR", token.address, address, 0n)));
    if (!noTrustline) throw error;
    return { ...base, native: held, token: holding(token, 0n), trustline: false };
  }
}

/** `walletBalance`, kept a few seconds per chain, wallet and token. */
async function cachedBalance(chainKey: string, address: string, token: SwapsApiToken): Promise<bigint | null> {
  const key = JSON.stringify([chainKey, address, token.address]);
  // Boxed, so a cached `null` (a missing account) isn't a miss.
  const cached = balances.get<{ units: bigint | null }>(key);
  if (cached) return cached.units;
  const units = await walletBalance(chainKey, address, token);
  balances.set(key, { units });
  return units;
}

function holding(token: SwapsApiToken, baseUnits: bigint): Holding {
  const { symbol, address, decimals } = token;
  return { symbol, address, decimals, amount: formatUnits(baseUnits, decimals), baseUnits: baseUnits.toString() };
}
