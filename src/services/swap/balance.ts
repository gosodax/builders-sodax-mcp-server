/** `sodax_get_balance`: a wallet's native balance and, optionally, one token's, read through the SDK. */

import { recipientReady, walletBalance } from "../sodax.js";
import type { ChainInfo } from "../sodaxApi.js";
import { ActionError } from "./errors.js";
import { checkAddress, resolveExactly, resolveSwapChain } from "./resolver.js";
import { chainRead } from "./source.js";
import { type SwapsApiToken, getSwapCatalog, nativeToken } from "./tokens.js";
import { formatUnits } from "./units.js";

export interface Holding {
  symbol: string;
  /** In token units, as a plain decimal. */
  amount: string;
  baseUnits: string;
}

export interface BalanceResult {
  status: "ok";
  chain: ChainInfo;
  address: string;
  native: Holding;
  /** The token asked for, unless it's the native coin. */
  token?: Holding;
  /** False when the account doesn't exist on the chain yet (Stellar, NEAR): it holds nothing there. */
  accountExists?: false;
  /** False when the Stellar account has no trustline for the token: it holds none and can't receive it yet. */
  trustline?: false;
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
      const units = await walletBalance(chain.key, address, token);
      // Only a native read may say the account is missing.
      if (units === null) throw new Error("no balance for the token");
      return units;
    });
  // Settled together: a failed token read counts only once the account is known to exist.
  const [nativeRead] = await Promise.allSettled([
    chainRead(chain, "balance", () => walletBalance(chain.key, address, native)),
    tokenUnits,
  ]);
  if (nativeRead.status === "rejected") throw nativeRead.reason;
  const base = { status: "ok" as const, chain, address };
  if (nativeRead.value === null) {
    // An account that doesn't exist holds nothing; Stellar fails its token reads rather than say so.
    return { ...base, native: holding(native, 0n), ...(token && { token: holding(token, 0n) }), accountExists: false };
  }
  const held = holding(native, nativeRead.value);
  if (!token || !tokenUnits) return { ...base, native: held };
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

function holding(token: SwapsApiToken, baseUnits: bigint): Holding {
  return { symbol: token.symbol, amount: formatUnits(baseUnits, token.decimals), baseUnits: baseUnits.toString() };
}
