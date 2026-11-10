/**
 * HTTP guards for the MCP endpoints: the request limiter, SSE session caps and
 * the final JSON error handler.
 */

import { STATUS_CODES } from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit, {
  MemoryStore,
  type RateLimitExceededEventHandler,
  type RateLimitInfo,
  ipKeyGenerator,
} from "express-rate-limit";
import { CLIENT_ID_KEYED } from "./analytics.js";
import { notifyError } from "./discord.js";
import { logger } from "./logger.js";
import { getRequestContext } from "./requestContext.js";

export const MCP_REQUESTS_PER_MINUTE = 60;
// Protocol 2025-03-26 allows JSON-RPC batches; each message counts as one request.
export const MCP_MAX_BATCH_SIZE = 10;

export const SSE_MAX_SESSIONS = 200;
export const SSE_MAX_SESSIONS_PER_IP = 10;
export const SSE_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour without a client message
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

const mcpLimitBody = limitBody(MCP_LIMIT_MESSAGE);

/** The route as the handlers see it: Express ignores case and a trailing slash. */
export const requestRoute = (req: Request): string => req.path.toLowerCase().replace(/\/$/, "");
// A record names only routes this server has; whatever else a client typed is "other", never logged.
const APP_ROUTE = /^\/(mcp|messages|sse|health|api)$/;
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
 * Per-IP limiter for /mcp, /sse and /messages. On /mcp a batch body counts once
 * per message and may hold at most MCP_MAX_BATCH_SIZE messages; the SSE
 * transport refuses batches, so elsewhere every request counts once.
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
    if (!isMcpPath(req) || !Array.isArray(req.body)) return next();
    if (req.body.length > MCP_MAX_BATCH_SIZE) {
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
      res.set("Retry-After", String(resetSeconds)).status(429).json(mcpLimitBody(req));
      return;
    }
    next();
  });

  return [limiter, countBatch];
}

/** Stateless /mcp offers no standalone SSE stream, so GET gets the spec's 405. */
export function mcpGetNotAllowed(_req: Request, res: Response): void {
  res.status(405).set("Allow", "POST, DELETE").json(jsonRpcError(-32000, "Method not allowed."));
}

export interface SseLease {
  /** Restarts the idle timer. */
  touch(): void;
  /** Frees the slot and stops the idle timer; safe to call twice. */
  release(): void;
}

/**
 * Caps open SSE sessions globally and per client, and ends idle ones. A client
 * is keyed like the rate limiter: an IPv4 address or an IPv6 /56 subnet.
 */
export class SseSessionLimiter {
  private readonly perIp = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxSessions = SSE_MAX_SESSIONS,
    private readonly maxPerIp = SSE_MAX_SESSIONS_PER_IP,
    private readonly idleMs = SSE_IDLE_TIMEOUT_MS,
  ) {}

  /** Takes a slot for `ip`, or returns null when a cap is reached. `onIdle` runs after idleMs without touch(). */
  open(ip: string, onIdle: () => void): SseLease | null {
    const client = ipKeyGenerator(ip);
    const count = this.perIp.get(client) ?? 0;
    if (this.total >= this.maxSessions || count >= this.maxPerIp) return null;
    this.perIp.set(client, count + 1);
    this.total++;

    const timer = setTimeout(onIdle, this.idleMs);
    let released = false;
    return {
      touch: () => {
        if (!released) timer.refresh();
      },
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        this.total--;
        const left = (this.perIp.get(client) ?? 1) - 1;
        if (left > 0) this.perIp.set(client, left);
        else this.perIp.delete(client);
      },
    };
  }
}

let lastErrorAlertAt = Number.NEGATIVE_INFINITY;

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
