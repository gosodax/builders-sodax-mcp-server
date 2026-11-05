/**
 * HTTP guards for the MCP endpoints: the request limiter, SSE session caps and
 * the final JSON error handler.
 */

import { STATUS_CODES } from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit, { MemoryStore, type RateLimitInfo, ipKeyGenerator } from "express-rate-limit";
import { notifyError } from "./discord.js";
import { logger } from "./logger.js";

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

function limitBody(req: Request) {
  return isMcpPath(req) ? jsonRpcError(-32000, MCP_LIMIT_MESSAGE) : { error: MCP_LIMIT_MESSAGE };
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
    windowMs: 60 * 1000,
    limit,
    store,
    standardHeaders: true,
    legacyHeaders: false,
    message: limitBody,
  });

  const countBatch = asyncHandler(async (req, res, next) => {
    if (!isMcpPath(req) || !Array.isArray(req.body)) return next();
    if (req.body.length > MCP_MAX_BATCH_SIZE) {
      res
        .status(400)
        .json(jsonRpcError(-32600, `Invalid Request: a batch may hold at most ${MCP_MAX_BATCH_SIZE} messages`));
      return;
    }
    // The limiter above already counted the first message.
    const { key } = (req as Request & { rateLimit: RateLimitInfo }).rateLimit;
    let used = 0;
    for (let i = 1; i < req.body.length; i++) used = (await store.increment(key)).totalHits;
    if (used > limit) {
      res.status(429).json(limitBody(req));
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
