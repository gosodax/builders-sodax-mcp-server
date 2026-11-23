/**
 * HTTP guards for the MCP endpoint: the request limiter and the final JSON
 * error handler.
 */

import { STATUS_CODES } from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit, { MemoryStore, type RateLimitExceededEventHandler, type RateLimitInfo } from "express-rate-limit";
import { CLIENT_ID_KEYED } from "./analytics.js";
import { notifyError } from "./discord.js";
import { logger } from "./logger.js";
import { getRequestContext } from "./requestContext.js";

export const MCP_REQUESTS_PER_MINUTE = 60;
// Protocol 2025-03-26 allows JSON-RPC batches; each message counts as one request.
export const MCP_MAX_BATCH_SIZE = 10;

// A run of failing requests alerts once, not once per request.
export const ERROR_ALERT_INTERVAL_MS = 60 * 1000;

const MCP_LIMIT_MESSAGE = "Too many MCP requests, please try again later.";

// Express routing ignores case and a trailing slash, so "/MCP" and "/mcp/" reach /mcp too.
const MCP_PATH = /^\/mcp\/?$/i;

function isMcpPath(req: Request): boolean {
  return MCP_PATH.test(req.path);
}

export function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/** A rate limiter's 429 body: a JSON-RPC error on /mcp, `{ error }` elsewhere. */
export function limitBody(message: string) {
  return (req: Request) => (isMcpPath(req) ? jsonRpcError(-32000, message) : { error: message });
}

const mcpLimitBody = () => jsonRpcError(-32000, MCP_LIMIT_MESSAGE);

/** Why a guard refused the request, for its "HTTP request" record (#110): a code, never what the client sent. */
export function noteRefusal(res: Response, errorType: string): void {
  res.locals.refusal = errorType;
}

export function refusalOf(res: Response): string | undefined {
  return res.locals.refusal;
}

/** The route as the handlers see it: Express ignores case and a trailing slash. */
export const requestRoute = (req: Request): string => req.path.toLowerCase().replace(/\/$/, "");
// A record names only routes this server has; whatever else a client typed is "other", never logged.
const APP_ROUTE = /^\/(mcp|health|api)$/;
const knownRoute = (req: Request): string => (APP_ROUTE.test(requestRoute(req)) ? requestRoute(req) : "other");

const WINDOW_MS = 60 * 1000;

/**
 * A limiter's refusal, logged once per client per window by whichever guard crossed the line (#110): refusals
 * aren't rate limited themselves, so a record for each would let a flood write the log.
 */
export function logRateLimited(req: Request, limit: number, windowMs = WINDOW_MS): void {
  const { clientId } = getRequestContext();
  logger.warn(
    {
      "http.route": knownRoute(req),
      "rate_limit.limit": limit,
      "rate_limit.window_ms": windowMs,
      "client.ip_hash": CLIENT_ID_KEYED ? clientId : undefined,
    },
    "Rate limited",
  );
}

/** The limiter's refusal: the first one in the window is logged. `message` is the refused request's body. */
export function rateLimitHandler(message: (req: Request) => unknown): RateLimitExceededEventHandler {
  return (req, res, _next, options) => {
    const { used, limit } = (req as Request & { rateLimit: RateLimitInfo }).rateLimit;
    if (used === limit + 1) logRateLimited(req, limit, options.windowMs);
    noteRefusal(res, "RATE_LIMITED");
    res.status(options.statusCode).json(message(req));
  };
}

/** Passes a rejected async handler to the error handler; Express 4 doesn't. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Per-IP limiter for /mcp. A batch body counts once per message and may hold at
 * most MCP_MAX_BATCH_SIZE messages.
 */
export function createMcpLimiter(limit = MCP_REQUESTS_PER_MINUTE): RequestHandler[] {
  const store = new MemoryStore();
  const limiter = rateLimit({
    windowMs: WINDOW_MS,
    limit,
    store,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler(mcpLimitBody),
  });

  const countBatch = asyncHandler(async (req, res, next) => {
    if (!Array.isArray(req.body)) return next();
    if (req.body.length > MCP_MAX_BATCH_SIZE) {
      noteRefusal(res, "BATCH_TOO_LARGE");
      res
        .status(400)
        .json(jsonRpcError(-32600, `Invalid Request: a batch may hold at most ${MCP_MAX_BATCH_SIZE} messages`));
      return;
    }
    // The limiter above already counted the first message and set its headers for that count alone.
    let { key, used, resetTime } = (req as Request & { rateLimit: RateLimitInfo }).rateLimit;
    for (let i = 1; i < req.body.length; i++) ({ totalHits: used, resetTime } = await store.increment(key));
    const resetSeconds = resetTime ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 60;
    res.set({ "RateLimit-Remaining": String(Math.max(limit - used, 0)), "RateLimit-Reset": String(resetSeconds) });
    if (used > limit) {
      // The limiter let the first message through, so this batch is the one that crossed the line.
      logRateLimited(req, limit);
      noteRefusal(res, "RATE_LIMITED");
      res.set("Retry-After", String(resetSeconds)).status(429).json(mcpLimitBody());
      return;
    }
    next();
  });

  return [limiter, countBatch];
}

/** Stateless /mcp offers no standalone SSE stream, so GET gets the spec's 405. */
export function mcpGetNotAllowed(_req: Request, res: Response): void {
  noteRefusal(res, "METHOD_NOT_ALLOWED");
  res.status(405).set("Allow", "POST, DELETE").json(jsonRpcError(-32000, "Method not allowed."));
}

let lastErrorAlertAt = Number.NEGATIVE_INFINITY;

// body-parser's error types, as the request's log record names them.
const BODY_REFUSALS: Record<string, string> = {
  "entity.parse.failed": "INVALID_JSON",
  "entity.too.large": "BODY_TOO_LARGE",
};

/** Final error handler: a JSON body (a JSON-RPC error on /mcp), never a stack trace. */
export function jsonErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const { status, type } = (err ?? {}) as { status?: unknown; type?: unknown };
  const code = typeof status === "number" && status >= 400 && status < 500 ? status : 500;
  if (code === 500) {
    logger.error({ err }, "Unhandled HTTP error");
    const now = Date.now();
    if (now - lastErrorAlertAt >= ERROR_ALERT_INTERVAL_MS) {
      lastErrorAlertAt = now;
      void notifyError(`Unhandled error on ${req.method} ${req.path}`, err);
    }
  }
  noteRefusal(res, code === 500 ? "INTERNAL" : (BODY_REFUSALS[String(type)] ?? "INVALID_REQUEST"));
  // Too late for a body: Express's default handler closes the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const parseError = type === "entity.parse.failed";
  const message = parseError ? "Parse error: invalid JSON" : (STATUS_CODES[code] ?? "Error");
  if (isMcpPath(req)) {
    res.status(code).json(jsonRpcError(parseError ? -32700 : code === 500 ? -32603 : -32600, message));
    return;
  }
  res.status(code).json({ error: message });
}
