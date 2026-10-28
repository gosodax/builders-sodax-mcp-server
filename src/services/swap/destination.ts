/**
 * Whether the recipient can hold the token: funds sent to a NEAR account without storage
 * for it, or a Stellar account without a trustline, get stuck. Checked through the SDK.
 */

import { logger } from "../logger.js";
import { recipientReady } from "../sodax.js";
import { ActionError } from "./errors.js";

export type RecipientCheck = "not_needed" | "ok";

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

const NOT_READY = {
  NEAR: (symbol: string) => ({
    message: `The recipient's NEAR account has no storage registered for ${symbol}.`,
    nextStep: `Tell the user the recipient must register storage for ${symbol} on NEAR before receiving it, then quote again.`,
  }),
  STELLAR: (symbol: string) => ({
    message: `The recipient's Stellar account has no trustline for this much ${symbol}.`,
    nextStep: `Tell the user the recipient must add (or raise) a trustline for ${symbol} on Stellar before receiving it, then quote again.`,
  }),
};

export async function checkRecipient(recipient: Recipient): Promise<RecipientCheck> {
  const { chainType, chainName, token, address, amount } = recipient;
  if (chainType !== "NEAR" && chainType !== "STELLAR") return "not_needed";
  let ready: boolean;
  try {
    ready = await recipientReady(chainType, token.address, address, amount);
  } catch {
    logger.warn({ chainKey: recipient.chainKey }, "Couldn't check the recipient");
    throw new ActionError("UPSTREAM_UNAVAILABLE", `Couldn't check the recipient on ${chainName}.`);
  }
  if (ready) return "ok";
  const { message, nextStep } = NOT_READY[chainType](token.symbol);
  throw new ActionError("DESTINATION_NOT_READY", message, { nextStep });
}
