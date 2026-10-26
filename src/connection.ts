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
