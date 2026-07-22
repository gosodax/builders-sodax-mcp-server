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

/**
 * Redaction allowlist (audit logger:L-1).
 *
 * Request URLs in this service embed wallet addresses and tx hashes
 * (`/intent/user/<addr>`, `/intent/tx/<hash>`), and DISCORD_WEBHOOK_URL is a
 * bearer-equivalent secret. Rather than trusting every call site to scrub, the
 * logger censors the field names those values realistically land in — both at
 * the top level and one level deep (pino supports a single leading `*`
 * wildcard), plus the standard `err.*` shapes produced by error serializers.
 *
 * Fields not listed here are logged normally; call sites that need a URL for
 * debugging should log a redacted/shape-only form (see `redactUrl` in http.ts).
 */
const REDACT_PATHS = [
  // URL-bearing fields (may embed addresses / tx hashes / query secrets)
  "url",
  "*.url",
  "uri",
  "*.uri",
  "endpoint",
  "*.endpoint",
  "webhookUrl",
  "*.webhookUrl",
  "webhook",
  "*.webhook",
  "err.url",
  "err.config",
  "err.request",
  "err.detail",
  // Secrets / credentials
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "password",
  "*.password",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "*.headers.authorization",
  // Raw upstream / request payloads
  "body",
  "*.body",
  "err.body",
];

const redact = { paths: REDACT_PATHS, censor: "[REDACTED]" };

export const logger: Logger = isDev
  ? pino({
      level,
      redact,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        target: "pino-pretty",
        options: { destination: 2, colorize: true, translateTime: "SYS:standard" },
      },
    })
  : pino({ level, redact, timestamp: pino.stdTimeFunctions.isoTime }, pino.destination(2));

if (requested !== undefined && !requestedIsValid) {
  logger.warn(
    { requested: process.env.LOG_LEVEL, fallback: "info", valid: VALID_LEVELS },
    "Invalid LOG_LEVEL — falling back to info",
  );
}
