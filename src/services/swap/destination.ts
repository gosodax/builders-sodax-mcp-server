/**
 * Whether the recipient can hold the token: funds sent to a NEAR account without storage
 * for it, or a Stellar account without a trustline, get stuck. Checked through the SDK.
 */

import { logger } from "../logger.js";
import { getSdk } from "../sodax.js";
import { ActionError } from "./errors.js";

export type RecipientCheck = "not_needed" | "ok";

const CHECK_TIMEOUT_MS = 15_000;

export interface Recipient {
  chainKey: string;
  chainType: string;
  chainName: string;
  /** The token received, as the swap catalog lists it. */
  token: { address: string; symbol: string };
  address: string;
  /** Base units the recipient is expected to receive. */
  amount: bigint;
}

export async function checkRecipient(recipient: Recipient): Promise<RecipientCheck> {
  const { chainType, chainName, token, address, amount } = recipient;
  if (chainType !== "NEAR" && chainType !== "STELLAR") return "not_needed";
  const { spoke } = getSdk().sodax;
  let ready: boolean;
  try {
    ready = await withTimeout(
      chainType === "NEAR"
        ? spoke.near.isStorageRegistered(token.address, address)
        : spoke.stellar.hasSufficientTrustline(token.address, amount, address),
    );
  } catch {
    // The SDK's error can carry the RPC URL and the address; only the chain is logged.
    logger.warn({ chainKey: recipient.chainKey }, "Couldn't check the recipient");
    throw new ActionError("UPSTREAM_UNAVAILABLE", `Couldn't check the recipient on ${chainName}.`);
  }
  if (ready) return "ok";
  throw new ActionError(
    "DESTINATION_NOT_READY",
    chainType === "NEAR"
      ? `The recipient's NEAR account has no storage registered for ${token.symbol}.`
      : `The recipient's Stellar account has no trustline for this much ${token.symbol}.`,
    {
      nextStep:
        chainType === "NEAR"
          ? `Tell the user the recipient must register storage for ${token.symbol} on NEAR before receiving it, then quote again.`
          : `Tell the user the recipient must add (or raise) a trustline for ${token.symbol} on Stellar before receiving it, then quote again.`,
    },
  );
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS).unref()),
  ]);
}
