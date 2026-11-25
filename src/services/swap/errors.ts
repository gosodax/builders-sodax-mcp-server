/** Failures the swap tools return as `{ status: "error", error: { code, message }, nextStep }` with `isError`. */

import { GET_A_KEY, SWAP_HELP } from "../../constants.js";

export const ACTION_ERROR_CODES = [
  "UNSUPPORTED_CHAIN",
  "UNSUPPORTED_SOURCE",
  "UNKNOWN_TOKEN",
  "RESTRICTED_TOKEN",
  "INVALID_AMOUNT",
  "INVALID_ADDRESS",
  "INVALID_TX_HASH",
  "AMOUNT_TOO_LOW",
  "DEADLINE_TOO_SHORT",
  "DESTINATION_NOT_READY",
  "SWAP_REJECTED",
  "SWAP_MISMATCH",
  "PRICE_OFF_MARKET",
  "SECRET_REJECTED",
  "QUOTE_NOT_FOUND",
  "QUOTE_MISMATCH",
  "QUOTE_KEY_MISMATCH",
  "API_KEY_REQUIRED",
  "RATE_LIMITED",
  "CHAIN_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
] as const;

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

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
  UNSUPPORTED_SOURCE: "A swap can't start from that chain: ask the user to swap from another one.",
  UNKNOWN_TOKEN:
    "Ask the user which token they mean (error.side says which side, when there are two; sodax_resolve_token lists candidates), then call the same tool again with it.",
  RESTRICTED_TOKEN: "Ask the user to pick a different token for that side of the swap.",
  INVALID_AMOUNT: "Ask the user for the amount as a plain number in token units, e.g. 0.5.",
  INVALID_ADDRESS: "Ask the user for a valid address on that chain.",
  INVALID_TX_HASH:
    "Ask for the hash of the transaction the user's wallet sent on the swap's source chain, as the wallet shows it (error.format).",
  AMOUNT_TOO_LOW: "Ask the user whether to quote a larger amount.",
  DEADLINE_TOO_SHORT: "Call sodax_swap_prepare again with a longer deadlineMinutes, e.g. 15.",
  DESTINATION_NOT_READY: "Tell the user what the recipient must set up before it can receive this token.",
  SWAP_REJECTED:
    "Tell the user the swap service refused this swap; check the tokens, amount and addresses with them before trying again.",
  SWAP_MISMATCH: "Tell the user this swap couldn't be prepared safely, and don't retry it.",
  PRICE_OFF_MARKET:
    "Tell the user the swap service quoted far below market prices (error.usdValue sent, error.usdOut received), so the swap wasn't prepared. On a small swap, fixed fees (to Bitcoin, for one) can cost this much: ask whether to try a larger amount; otherwise try again later.",
  SECRET_REJECTED:
    "Tell the user to treat it as exposed and move their funds, and never to paste it into a chat; ask for the wallet's public address instead.",
  QUOTE_NOT_FOUND:
    "Call again with chain set to the swap's source chain key, or with the quoteId from sodax_swap_prepare.",
  QUOTE_MISMATCH: "That quoteId is for another source chain: pass the quoteId this transaction was made from.",
  QUOTE_KEY_MISMATCH:
    "This connection's SODAX API key has changed since the quote was made, and only that key can use it: tell the user.",
  API_KEY_REQUIRED: `Ask the user for a valid SODAX API key, sent as the x-api-key header. ${GET_A_KEY}`,
  RATE_LIMITED: "Wait retryAfterSec seconds, then try again.",
  // One chain's node, not the swap service: the other chains may still work.
  CHAIN_UNAVAILABLE:
    "Retry in a minute; if it still fails, tell the user that chain can't be read right now (error.message names it) and to try again later.",
  UPSTREAM_UNAVAILABLE: RETRY_LATER,
  // A bug: retrying may not help, and someone at SODAX should look.
  INTERNAL: `${RETRY_LATER} ${SWAP_HELP}`,
};

/** Whether the throw site left the code's own advice, which says nothing about this failure in particular. */
export const hasDefaultNextStep = (error: ActionError): boolean => error.nextStep === DEFAULT_NEXT_STEP[error.code];

/** A value the user can pick to fix a failure: what it's called, and the arguments it sets. */
export interface ErrorOption {
  label: string;
  args: Record<string, string>;
}

/**
 * What a failure's next action needs beyond its details, never returned as is: `options` from the catalog for the
 * user to pick from, or the canonical arguments of the balance read that explains it.
 */
export interface ErrorHint {
  options?: ErrorOption[];
  balance?: { chain: string; address: string; token: string };
}

export class ActionError extends Error {
  readonly nextStep: string;
  readonly details?: Record<string, unknown>;
  readonly hint?: ErrorHint;
  /** Calling again with the same arguments can work: its code's default, unless the throw site knows better. */
  readonly retryable: boolean;

  constructor(
    readonly code: ActionErrorCode,
    message: string,
    options: { nextStep?: string; details?: Record<string, unknown>; hint?: ErrorHint; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ActionError";
    this.nextStep = options.nextStep ?? DEFAULT_NEXT_STEP[code];
    this.details = options.details;
    this.hint = options.hint;
    this.retryable = options.retryable ?? RETRYABLE_CODES.includes(code);
  }
}
