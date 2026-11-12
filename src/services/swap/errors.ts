/** Failures the swap tools return as `{ status: "error", error: { code, message }, nextStep }` with `isError`. */

import { GET_A_KEY } from "../../constants.js";

export type ActionErrorCode =
  | "UNSUPPORTED_CHAIN"
  | "UNSUPPORTED_SOURCE"
  | "UNKNOWN_TOKEN"
  | "RESTRICTED_TOKEN"
  | "INVALID_AMOUNT"
  | "INVALID_ADDRESS"
  | "AMOUNT_TOO_LOW"
  | "DEADLINE_TOO_SHORT"
  | "DESTINATION_NOT_READY"
  | "SWAP_REJECTED"
  | "SWAP_MISMATCH"
  | "PRICE_OFF_MARKET"
  | "SECRET_REJECTED"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_MISMATCH"
  | "QUOTE_KEY_MISMATCH"
  | "API_KEY_REQUIRED"
  | "RATE_LIMITED"
  | "CHAIN_UNAVAILABLE"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL";

/** Failures that may pass on their own: calling again with the same arguments can work. */
export const RETRYABLE_CODES: readonly ActionErrorCode[] = [
  "RATE_LIMITED",
  "CHAIN_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
];

/** Failures that point at a bug, or at the swap service building or pricing a swap wrong: someone should look. */
export const ALERTED_CODES: readonly ActionErrorCode[] = ["INTERNAL", "SWAP_MISMATCH", "PRICE_OFF_MARKET"];

/** Swap failures on SODAX's side, not the caller's: their "Tool call" record is a warning (toolFailure.ts). */
export const SODAX_SIDE_CODES: readonly ActionErrorCode[] = [
  ...ALERTED_CODES,
  "CHAIN_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
];

const RETRY_LATER = "Retry in a minute; if it still fails, tell the user the SODAX swap service is unavailable.";

const DEFAULT_NEXT_STEP: Record<ActionErrorCode, string> = {
  UNSUPPORTED_CHAIN: "Ask the user which chain in error.supportedChains they mean and pass its key.",
  UNSUPPORTED_SOURCE: "A swap can't start from that chain yet: ask the user to swap from another one.",
  UNKNOWN_TOKEN:
    "Call sodax_resolve_token for that token (error.side says which, when there are two) and follow its nextStep.",
  RESTRICTED_TOKEN: "Ask the user to pick a different token for that side of the swap.",
  INVALID_AMOUNT: "Ask the user for the amount as a plain number in token units, e.g. 0.5.",
  INVALID_ADDRESS: "Ask the user for a valid address on that chain.",
  AMOUNT_TOO_LOW: "Ask the user whether to quote a larger amount.",
  DEADLINE_TOO_SHORT: "Call sodax_swap_quote again with a longer deadlineMinutes, e.g. 15.",
  DESTINATION_NOT_READY: "Tell the user what the recipient must set up before it can receive this token.",
  SWAP_REJECTED:
    "Tell the user the swap service refused this swap; check the tokens, amount and addresses with them before trying again.",
  SWAP_MISMATCH: "Tell the user this swap couldn't be prepared safely, and don't retry it.",
  PRICE_OFF_MARKET:
    "Tell the user the swap service quoted far below market prices (error.usdValue sent, error.usdOut received), so the swap wasn't prepared; try again later.",
  SECRET_REJECTED:
    "Tell the user to treat it as exposed and move their funds, and never to paste it into a chat; ask for the wallet's public address instead.",
  QUOTE_NOT_FOUND:
    "Call again with chain set to the swap's source chain key, or with the quoteId from sodax_swap_quote.",
  QUOTE_MISMATCH: "That quoteId is for another source chain: pass the quoteId this transaction was made from.",
  QUOTE_KEY_MISMATCH:
    "This connection's SODAX API key has changed since the quote was made, and only that key can use it: tell the user.",
  API_KEY_REQUIRED: `Ask the user for a valid SODAX API key, sent as the x-api-key header. ${GET_A_KEY}`,
  RATE_LIMITED: "Wait retryAfterSec seconds, then try again.",
  CHAIN_UNAVAILABLE: RETRY_LATER,
  UPSTREAM_UNAVAILABLE: RETRY_LATER,
  INTERNAL: RETRY_LATER,
};

export class ActionError extends Error {
  readonly nextStep: string;
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: ActionErrorCode,
    message: string,
    options: { nextStep?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ActionError";
    this.nextStep = options.nextStep ?? DEFAULT_NEXT_STEP[code];
    this.details = options.details;
  }
}
