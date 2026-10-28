/** Failures the swap tools return as `{ status: "error", error: { code, message }, nextStep }` with `isError`. */

import { API_KEYS_DOCS_URL } from "../../constants.js";

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
  | "API_KEY_REQUIRED"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL";

const RETRY_LATER = "Retry in a minute; if it still fails, tell the user the SODAX swap service is unavailable.";

const DEFAULT_NEXT_STEP: Record<ActionErrorCode, string> = {
  UNSUPPORTED_CHAIN: "Ask the user which chain in error.supportedChains they mean and pass its key.",
  UNSUPPORTED_SOURCE:
    "Swaps can only start from an EVM chain such as Arbitrum or Base for now; ask the user to send from one.",
  UNKNOWN_TOKEN: "Call sodax_resolve_token for that side (error.side) and follow its nextStep.",
  RESTRICTED_TOKEN: "Ask the user to pick a different token for that side of the swap.",
  INVALID_AMOUNT: "Ask the user for the amount as a plain number in token units, e.g. 0.5.",
  INVALID_ADDRESS: "Ask the user for a valid address on that chain.",
  AMOUNT_TOO_LOW: "Ask the user for a larger amount.",
  DEADLINE_TOO_SHORT: "Call sodax_swap_quote again with a longer deadlineMinutes, e.g. 15.",
  DESTINATION_NOT_READY: "Tell the user what the recipient must set up before it can receive this token.",
  SWAP_REJECTED:
    "Tell the user the swap service refused this swap; check the tokens, amount and addresses with them before trying again.",
  SWAP_MISMATCH: "Tell the user this swap couldn't be prepared safely, and don't retry it.",
  API_KEY_REQUIRED: `Ask the user for a valid SODAX API key, sent as the x-api-key header: ${API_KEYS_DOCS_URL}`,
  RATE_LIMITED: "Wait retryAfterSec seconds, then try again.",
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
