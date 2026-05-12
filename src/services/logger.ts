/**
 * Central logger.
 *
 * Writes to stderr (fd 2) — never stdout — because the MCP stdio transport
 * reserves stdout for JSON-RPC framing. Sending logs to stdout would corrupt
 * the protocol stream for stdio clients.
 *
 * - Level via LOG_LEVEL env (default "info"). Valid: trace|debug|info|warn|error|fatal.
 * - JSON output in production, pino-pretty in dev.
 */

import pino, { type Logger } from "pino";

const level = process.env.LOG_LEVEL || "info";
const isDev = process.env.NODE_ENV !== "production";

export const logger: Logger = isDev
  ? pino({
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        target: "pino-pretty",
        options: { destination: 2, colorize: true, translateTime: "SYS:standard" },
      },
    })
  : pino({ level, timestamp: pino.stdTimeFunctions.isoTime }, pino.destination(2));
