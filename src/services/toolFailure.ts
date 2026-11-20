/**
 * Why a tool call failed, for its "Tool call" record (#110), without changing what the agent receives: the
 * result object a tool returns carries a code (`error.type`) and, for a bug, the error itself.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BadResponseError, HttpError } from "./http.js";
import { errorCode } from "./logger.js";
import { SODAX_SIDE_CODES } from "./swap/errors.js";

export interface ToolFailure {
  code: string;
  /** Set when nothing explains the failure: a bug, logged with its class and stack. */
  thrown?: unknown;
}

/** Caller input a data service refuses before calling anything. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const failures = new WeakMap<object, ToolFailure>();

export function markFailure<T extends object>(result: T, failure: ToolFailure): T {
  failures.set(result, failure);
  return result;
}

export function failureOf(result: unknown): ToolFailure | undefined {
  return result !== null && typeof result === "object" ? failures.get(result) : undefined;
}

/** The text a data tool has always answered a failure with, the failure's code kept for the record. */
export function failedResult(
  error: unknown,
  text = `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
): CallToolResult {
  return markFailure({ content: [{ type: "text", text }], isError: true }, classifyFailure(error));
}

/** The services wrap what went wrong (`cause`); the first error in the chain that says why names the failure. */
export function classifyFailure(error: unknown): ToolFailure {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const code = codeOf(current);
    if (code) return { code };
  }
  return { code: "INTERNAL", thrown: error };
}

function codeOf(error: Error): string | undefined {
  if (error instanceof InputError) return "INVALID_INPUT";
  if (error instanceof HttpError) {
    if (error.status === 404) return "UPSTREAM_NOT_FOUND";
    // With the caller's key it's their quota, as a swap tool's RATE_LIMITED; without, this server's shared egress.
    if (error.status === 429) return error.keyed ? "RATE_LIMITED" : "UPSTREAM_RATE_LIMITED";
    return error.status >= 500 ? "UPSTREAM_5XX" : "UPSTREAM_4XX";
  }
  // AbortSignal.timeout's abort.
  if (error.name === "TimeoutError") return "UPSTREAM_TIMEOUT";
  if (error instanceof BadResponseError) return "UPSTREAM_BAD_RESPONSE";
  // fetch's network failures, TypeErrors from undici: "fetch failed" (no connection, DNS, a refused redirect), or one
  // whose cause is a socket error ("terminated" by UND_ERR_SOCKET when it drops mid-body).
  if (error instanceof TypeError && (error.message === "fetch failed" || isSocketCode(errorCode(error.cause)))) {
    return "UPSTREAM_UNREACHABLE";
  }
  return undefined;
}

/** undici's own (UND_ERR_SOCKET) or an errno (ECONNRESET), not Node's argument errors (ERR_INVALID_ARG_TYPE). */
const isSocketCode = (code: string | undefined) => code !== undefined && /^(UND_ERR_[A-Z_]+|E[A-Z]+)$/.test(code);

/** Failures on SODAX's side, not the caller's: their "Tool call" record is a warning. */
export const SERVER_SIDE_CODES: ReadonlySet<string> = new Set([
  ...SODAX_SIDE_CODES,
  // Keyless calls share this server's egress limit: throttling it fails every keyless caller.
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_5XX",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNREACHABLE",
  "UPSTREAM_BAD_RESPONSE",
  "DOCS_UNAVAILABLE",
]);
