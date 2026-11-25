/** The swap tools' shared checks, worded for a bridge when a bridge tool runs them: they name the swap tools. */

import { ActionError } from "../swap/errors.js";

/** Runs a shared check, its failure reworded for a bridge. */
export function bridged<T>(check: () => T): T {
  try {
    const result = check();
    return result instanceof Promise ? (result.catch(rewordForBridge) as T) : result;
  } catch (error) {
    return rewordForBridge(error);
  }
}

function rewordForBridge(error: unknown): never {
  if (!(error instanceof ActionError)) throw error;
  const reword = (text: string) =>
    text
      .replaceAll("sodax_swap_prepare", "sodax_bridge_prepare")
      .replace(/\bswaps?\b/g, match => (match === "swaps" ? "bridges" : "bridge"))
      .replace(/\bSwaps\b/g, "Bridges");
  throw new ActionError(error.code, reword(error.message), {
    nextStep: reword(error.nextStep),
    details: error.details,
    hint: error.hint,
    retryable: error.retryable,
  });
}
