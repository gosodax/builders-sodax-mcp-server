/**
 * Whether the recipient can hold the token: funds sent to a NEAR account
 * without storage, or a Stellar account without a trustline, get stuck.
 */

import { ActionError } from "./errors.js";

export type RecipientCheck = "not_needed" | "ok";

export async function checkRecipient(chainType: string): Promise<RecipientCheck> {
  if (chainType === "NEAR" || chainType === "STELLAR") {
    throw new ActionError("UNSUPPORTED_CHAIN", "This server can't check a NEAR or Stellar recipient yet.", {
      nextStep: "Ask the user to receive on another chain for now.",
    });
  }
  return "not_needed";
}
