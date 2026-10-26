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

/**
 * Text with every URL replaced. RPC URLs reach error messages (viem, the SDK), and an RPC override
 * can embed a paid key, so nothing logged or posted keeps a URL.
 */
export function withoutUrls(text: string): string {
  // Stops at quotes and backslashes too, so it can run over serialized JSON.
  return text.replace(/https?:\/\/[^\s"'\\<>]+/gi, "<url>");
}

/** JSON that can't throw: bigints as strings, cycles cut. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  });
}

/**
 * pino's error serializer, with URLs gone from every field (viem errors carry them in `url`, `cause`
 * and more), for thrown strings and plain objects too. It never throws: a logger that throws hides
 * the error it was given.
 */
export function errWithoutUrls(error: unknown): unknown {
  try {
    const serialized = error instanceof Error ? pino.stdSerializers.err(error) : error;
    return serialized === undefined ? undefined : JSON.parse(withoutUrls(safeJson(serialized)));
  } catch {
    return { type: typeof error, message: "unserializable error" };
  }
}

const serializers = { err: errWithoutUrls };

const VALID_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
type LogLevel = (typeof VALID_LEVELS)[number];

const requested = process.env.LOG_LEVEL?.toLowerCase();
const requestedIsValid = requested === undefined || (VALID_LEVELS as readonly string[]).includes(requested);
const level: LogLevel = (requestedIsValid ? (requested ?? "info") : "info") as LogLevel;

const isDev = process.env.NODE_ENV === "development";

export const logger: Logger = isDev
  ? pino({
      level,
      serializers,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        target: "pino-pretty",
        options: { destination: 2, colorize: true, translateTime: "SYS:standard" },
      },
    })
  : pino({ level, serializers, timestamp: pino.stdTimeFunctions.isoTime }, pino.destination(2));

if (requested !== undefined && !requestedIsValid) {
  logger.warn(
    { requested: process.env.LOG_LEVEL, fallback: "info", valid: VALID_LEVELS },
    "Invalid LOG_LEVEL — falling back to info",
  );
}
