/**
 * The swap tools' shared checks and default advice name the swap tools: a bridge tool's failure is reworded for a
 * bridge where its result is built (`registerActionTool`), so no path through them leaks swap wording.
 */

import { ActionError, inBridgeWords as reword } from "../swap/errors.js";

export function forBridge(error: ActionError): ActionError {
  return new ActionError(error.code, reword(error.message), {
    nextStep: reword(error.nextStep),
    details: error.details,
    hint: error.hint,
    retryable: error.retryable,
  });
}
