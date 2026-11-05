/** Failures the swap tools return as `{ status: "error", error: { code, message }, nextStep }` with `isError`. */
export type ActionErrorCode = "UNSUPPORTED_CHAIN" | "UPSTREAM_UNAVAILABLE" | "INTERNAL";

const RETRY_LATER = "Retry in a minute; if it still fails, tell the user the SODAX swap service is unavailable.";

const DEFAULT_NEXT_STEP: Record<ActionErrorCode, string> = {
  UNSUPPORTED_CHAIN: "Ask the user which chain in error.supportedChains they mean and pass its key.",
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
