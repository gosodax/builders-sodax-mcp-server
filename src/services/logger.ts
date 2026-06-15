/**
 * Central logger.
 *
 * Writes to stderr (fd 2) — never stdout — because the MCP stdio transport
 * reserves stdout for JSON-RPC framing. Sending logs to stdout would corrupt
 * the protocol stream for stdio clients.
 *
 * - Level via LOG_LEVEL env (default "info"). Valid: trace|debug|info|warn|error|fatal|silent.
 *   `silent` disables all logging — used by vitest to keep test runs quiet.
 *   Unknown values fall back to "info" with a warning rather than crashing at boot.
 * - JSON output by default; `pino-pretty` transport only when `NODE_ENV === "development"`
 *   (opt-in). Defaulting to JSON means an unset `NODE_ENV` on a production-only install
 *   (`pnpm install --prod`, which strips `pino-pretty`) won't crash at boot.
 */

import pino, { type Logger } from "pino";

const VALID_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
type LogLevel = (typeof VALID_LEVELS)[number];

const requested = process.env.LOG_LEVEL?.toLowerCase();
const requestedIsValid = requested === undefined || (VALID_LEVELS as readonly string[]).includes(requested);
const level: LogLevel = (requestedIsValid ? (requested ?? "info") : "info") as LogLevel;

const isDev = process.env.NODE_ENV === "development";

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

if (requested !== undefined && !requestedIsValid) {
  logger.warn(
    { requested: process.env.LOG_LEVEL, fallback: "info", valid: VALID_LEVELS },
    "Invalid LOG_LEVEL — falling back to info",
  );
}
