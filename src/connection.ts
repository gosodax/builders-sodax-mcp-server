/**
 * What an HTTP connection gets, read from its request once: the caller's API key, partner fee and toolsets.
 */

import type { Request, Response } from "express";
import {
  type KeyCheck,
  type KeyChecker,
  type KeyRefusal,
  SWAP_SCOPES,
  checkApiKey,
} from "./services/apiKeyVerification.js";
import { noteKeyCheck, noteRefusal } from "./services/httpGuards.js";
import { logger } from "./services/logger.js";
import { partnerFeeFromRequest } from "./services/partnerFee.js";
import {
  ConnectionError,
  type ToolSelection,
  apiKeyStatus,
  keyRefusalError,
  profileFromRequest,
  selectToolsets,
} from "./services/profiles.js";
import { type RequestContext, parseApiKey } from "./services/requestContext.js";

/** The SODAX API key a client sent, forwarded on its data API and solver calls. Absent → keyless. */
export function callerApiKey(req: Request): string | undefined {
  return parseApiKey(req.get("x-api-key"));
}

/**
 * The keyset's verdict on a SODAX key, noted on the request's record, and why `enforce` refuses it (`monitor`
 * only records); none without a key or a key check.
 */
function checkKey(
  res: Response,
  apiKey: string | undefined,
  keyChecker: KeyChecker | undefined,
): { check?: KeyCheck; refused?: KeyRefusal } {
  if (!apiKey || !keyChecker) return {};
  const check = checkApiKey(keyChecker.keyset, apiKey, SWAP_SCOPES);
  noteKeyCheck(res, check);
  const refused = keyChecker.mode === "enforce" && check.outcome !== "ok" ? check.outcome : undefined;
  return { check, refused };
}

function refuse(res: Response, error: ConnectionError): undefined {
  noteRefusal(res, error.code);
  res
    .status(error.httpStatus)
    .json({ jsonrpc: "2.0", error: { code: error.rpcCode, message: error.message }, id: null });
  return undefined;
}

/**
 * The context a POST /messages runs in: its SSE session's, with the message's own key. A session opened
 * with a key serves its tools only to messages that send that key; undefined once a message is refused.
 * With a key check, each message's key is checked again, so a key revoked mid-session is recorded, and
 * `enforce` refuses it on a session that has swap tools.
 */
export function messageContext(
  session: RequestContext,
  req: Request,
  res: Response,
  keyChecker?: KeyChecker,
  swap = false,
): RequestContext | undefined {
  const apiKey = callerApiKey(req);
  if (session.apiKey !== undefined && apiKey !== session.apiKey) {
    const message = "Send each message with the x-api-key this SSE session was opened with.";
    return refuse(res, new ConnectionError(403, "SSE_KEY_MISMATCH", message));
  }
  // A keyed session's messages carry its key, so this verdict replaces the one it opened with.
  const { check, refused } = checkKey(res, apiKey, keyChecker);
  if (swap && refused) return refuse(res, keyRefusalError(refused));
  return { ...session, apiKey, keyCheck: check };
}

/** A connection's settings, resolved once; undefined once it has been refused. */
export function resolveConnection(
  req: Request,
  res: Response,
  swapToolsEnabled: boolean,
  keyChecker?: KeyChecker,
): { context: RequestContext; toolsets: ToolSelection } | undefined {
  const rawKey = req.get("x-api-key");
  const keyStatus = apiKeyStatus(rawKey);
  const apiKey = parseApiKey(rawKey);
  // Before any refusal, so a refused request's record keeps the verdict.
  const { check, refused } = checkKey(res, apiKey, keyChecker);
  try {
    const toolsets = selectToolsets(profileFromRequest(req), {
      apiKey: keyStatus,
      swapToolsEnabled,
      keyRefused: refused,
    });
    const partnerFee = partnerFeeFromRequest(req);
    // Debug: it repeats on every request and the client's instructions say it. Never the value: it may be a secret.
    if (keyStatus === "malformed") logger.debug("x-api-key is not a SODAX API key (sodax_…); calls go out keyless");
    return { context: { apiKey, partnerFee, keyCheck: check }, toolsets };
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    return refuse(res, error);
  }
}
