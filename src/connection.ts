/**
 * What an HTTP connection gets, read from its request once: the caller's API key, partner fee and toolsets.
 */

import type { Request, Response } from "express";
import { logger } from "./services/logger.js";
import { partnerFeeFromRequest } from "./services/partnerFee.js";
import {
  ConnectionError,
  type ToolSelection,
  apiKeyStatus,
  profileFromRequest,
  selectToolsets,
} from "./services/profiles.js";
import { type RequestContext, parseApiKey } from "./services/requestContext.js";

/** The SODAX API key a client sent, forwarded on its data API and solver calls. Absent → keyless. */
export function callerApiKey(req: Request): string | undefined {
  return parseApiKey(req.get("x-api-key"));
}

/**
 * The context a POST /messages runs in: its SSE session's, with the message's own key. A session opened
 * with a key serves its tools only to messages that send that key; undefined once a message is refused.
 */
export function messageContext(session: RequestContext, req: Request, res: Response): RequestContext | undefined {
  const apiKey = callerApiKey(req);
  if (session.apiKey === undefined || apiKey === session.apiKey) return { ...session, apiKey };
  const message = "Send each message with the x-api-key this SSE session was opened with.";
  res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  return undefined;
}

/** A connection's settings, resolved once; undefined once it has been refused. */
export function resolveConnection(
  req: Request,
  res: Response,
  swapToolsEnabled: boolean,
): { context: RequestContext; toolsets: ToolSelection } | undefined {
  const rawKey = req.get("x-api-key");
  const keyStatus = apiKeyStatus(rawKey);
  try {
    const toolsets = selectToolsets(profileFromRequest(req), { apiKey: keyStatus, swapToolsEnabled });
    const partnerFee = partnerFeeFromRequest(req);
    // Debug: it repeats on every request and the client's instructions say it. Never the value: it may be a secret.
    if (keyStatus === "malformed") logger.debug("x-api-key is not a SODAX API key (sodax_…); calls go out keyless");
    return { context: { apiKey: parseApiKey(rawKey), partnerFee }, toolsets };
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    res
      .status(error.httpStatus)
      .json({ jsonrpc: "2.0", error: { code: error.rpcCode, message: error.message }, id: null });
    return undefined;
  }
}
