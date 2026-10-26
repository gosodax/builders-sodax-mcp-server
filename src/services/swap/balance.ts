/** `sodax_get_balance`: a wallet's native balance and, optionally, one token's, read through the SDK. */

import { walletBalance } from "../sodax.js";
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
}

export async function readBalances(input: { chain: string; address: string; token?: string }): Promise<BalanceResult> {
  const catalog = await getSwapCatalog();
  const chain = resolveSwapChain(catalog, input.chain);
  const native = nativeToken(catalog, chain.key);
  if (!native)
    throw new ActionError("UPSTREAM_UNAVAILABLE", `The swap token list has no native token for ${chain.name}.`);
  const address = checkAddress(input.address, chain);
  const asked = input.token ? resolveExactly(catalog, chain.key, input.token).token : undefined;
  const token = asked?.isNative ? undefined : asked;
  // The SDK reads only BTC on Bitcoin, and would report any other token there as 0.
  if (token && catalog.chains[chain.key]?.type === "BITCOIN") {
    throw new ActionError("UNKNOWN_TOKEN", "Only the BTC balance can be read on Bitcoin.", {
      nextStep: "Ask for the BTC balance instead.",
    });
  }

  // Validated before any read; a failed read is CHAIN_UNAVAILABLE, never 0.
  const read = (wanted: SwapsApiToken) => chainRead(chain, "balance", () => walletBalance(chain.key, address, wanted));
  const [nativeRead, tokenRead] = await Promise.allSettled([read(native), token && read(token)]);
  if (nativeRead.status === "rejected") throw nativeRead.reason;
  // An account that doesn't exist holds nothing; Stellar fails its token reads rather than say so.
  const accountExists = nativeRead.value !== null;
  if (accountExists && tokenRead.status === "rejected") throw tokenRead.reason;
  const tokenUnits = tokenRead.status === "fulfilled" ? tokenRead.value : undefined;
  return {
    status: "ok",
    chain,
    address,
    native: holding(native, nativeRead.value ?? 0n),
    ...(token && { token: holding(token, accountExists ? (tokenUnits ?? 0n) : 0n) }),
    ...(!accountExists && { accountExists: false as const }),
  };
}

function holding(token: SwapsApiToken, baseUnits: bigint): Holding {
  return { symbol: token.symbol, amount: formatUnits(baseUnits, token.decimals), baseUnits: baseUnits.toString() };
}
