/**
 * The swap tools' shared checks and default advice name the swap tools: a bridge tool's failure is reworded for a
 * bridge where its result is built (`registerActionTool`), so no path through them leaks swap wording.
 */

import { ActionError } from "../swap/errors.js";

const reword = (text: string) =>
  text
    .replace(/\bsodax_swap_(prepare|submit_and_track)\b/g, "sodax_bridge_$1")
    // The bridge's tokens aren't the swap's: a lookup for one names it.
    .replace(/\bsodax_resolve_token\b(?! with for: bridge)/g, "sodax_resolve_token with for: bridge")
    .replace(/\bswap\b/g, "bridge")
    .replace(/\bswaps\b/g, "bridges")
    .replace(/\bSwap\b/g, "Bridge")
    .replace(/\bSwaps\b/g, "Bridges");

export function forBridge(error: ActionError): ActionError {
  return new ActionError(error.code, reword(error.message), {
    nextStep: reword(error.nextStep),
    details: error.details,
    hint: error.hint,
    retryable: error.retryable,
  });
}
