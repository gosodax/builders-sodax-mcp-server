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

import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { isSodaxKey } from "../constants.js";
import type { OtelLogs } from "./otel.js";
import { getRequestContext } from "./requestContext.js";

// Any scheme (https, wss, …), slashes JSON-escaped or not; stops at quotes and backslashes, so it can
// run over serialized JSON. The scheme is bounded so a long run without "://" (from a hostile RPC's
// body) stays linear, and a run of plain characters is one loop step.
const URL_PATTERN = /[a-z][a-z0-9+.-]{0,31}:(?:\/\/|\\\/\\\/)(?:[^\s"'\\<>]+|\\\/)+/gi;
// Fields whose value is a key, or a request or call (viem's `body`, `args`, `sender`… hold the user's
// address), whatever it looks like.
const KEY_FIELD = /^(?:x-api-key|api-?key|authorization)$/i;
const CALL_FIELD = /^(?:body|requestBody|args|sender|from|data|account)$/i;
// Those same parts in viem's message text: "Request body: …", and the indented lines of its call details.
const CALL_LINE = /^(\s+(?:args|sender|from|data|account):)[^\n]*/gm;

const withoutUrls = (text: string) => text.replace(URL_PATTERN, url => (/^file:/i.test(url) ? url : "<url>"));

/**
 * Text with URLs, request bodies and keys replaced. RPC URLs reach error messages (viem, the SDK) and
 * an RPC override can embed a paid key; viem quotes the request body, which holds the user's address.
 * A `file:` URL is a stack frame's path, kept so a stack still says where it failed.
 */
export function redact(text: string): string {
  return (
    withoutUrls(text)
      .replace(/Request body: [^\n]*/g, "Request body: <redacted>")
      .replace(CALL_LINE, "$1 <redacted>")
      // Shorter than a whole key on purpose: upstream text cut mid-key still loses the part it kept.
      .replace(/sodax_[A-Za-z0-9_-]{8,}/g, key => (isSodaxKey(key) ? "<key>" : key))
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <key>")
  );
}

/**
 * JSON that can't throw, redacted: bigints as strings, cycles cut, every string through `redact`, and
 * key and request-body fields replaced whole, before their contents are serialized.
 */
function redactedJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, item: unknown) => {
    if (CALL_FIELD.test(key)) return "<redacted>";
    if (typeof item === "string") return KEY_FIELD.test(key) ? "<key>" : redact(item);
    if (typeof item === "bigint") return item.toString();
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  });
}

/**
 * pino's error serializer, redacted (viem errors carry URLs and the request body in `message`, `url`,
 * `body`, `metaMessages`, `cause` and more), for thrown strings and plain objects too. It never
 * throws: a logger that throws hides the error it was given.
 */
export function redactErr(error: unknown): unknown {
  try {
    const serialized = error instanceof Error ? pino.stdSerializers.err(error) : error;
    // URLs once more over the whole text: a property name can be one too.
    return serialized === undefined ? undefined : JSON.parse(withoutUrls(redactedJson(serialized)));
  } catch {
    return { type: typeof error, message: "unserializable error" };
  }
}

const VALID_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
type LogLevel = (typeof VALID_LEVELS)[number];

const requested = process.env.LOG_LEVEL?.toLowerCase();
const requestedIsValid = requested === undefined || (VALID_LEVELS as readonly string[]).includes(requested);
const level: LogLevel = (requestedIsValid ? (requested ?? "info") : "info") as LogLevel;

const isDev = process.env.NODE_ENV === "development";

// One options object for both outputs, so neither can lose the redacting serializer.
const options: LoggerOptions = {
  level,
  serializers: { err: redactErr },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Every record of one MCP request (or stdio tool call) carries its id (#110).
  mixin: () => {
    const { requestId } = getRequestContext();
    return requestId ? { "request.id": requestId } : {};
  },
  // The serialized line, before the destination writes it: the OTLP destination reads the same bytes stderr gets.
  hooks: {
    streamWrite: line => {
      otelLogs?.write(line);
      return line;
    },
  },
};

export const logger: Logger = isDev
  ? pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { destination: 2, colorize: true, translateTime: "SYS:standard" },
      },
    })
  : pino(options, pino.destination(2));

let otelLogs: OtelLogs | undefined;

/** From here on every line the logger writes also goes to unified logging (#110); see `options.hooks`. */
export function attachOtelLogs(otel: OtelLogs): void {
  otelLogs = otel;
}

export function detachOtelLogs(): void {
  otelLogs = undefined;
}

/** A logger with the same options over any destination: how tests read records without the singleton. */
export const buildLogger = (stream: DestinationStream, overrides: Partial<LoggerOptions> = {}): Logger =>
  pino({ ...options, ...overrides }, stream);

if (requested !== undefined && !requestedIsValid) {
  logger.warn(
    { requested: process.env.LOG_LEVEL, fallback: "info", valid: VALID_LEVELS },
    "Invalid LOG_LEVEL — falling back to info",
  );
}

/**
 * A thrown value's name for an `error.type` attribute: what failed, never its text. Node's errors carry a code
 * themselves (ECONNRESET); fetch wraps the reason in `cause.code` (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT) under a
 * bare TypeError. Only a code-shaped value is taken, since viem puts the raw RPC error object in `cause`.
 */
export function errorName(error: unknown): string {
  return (
    errorCode(error) ??
    errorCode((error as { cause?: unknown } | undefined)?.cause) ??
    (error instanceof Error ? error.name : typeof error)
  );
}

/** A value's `code` when it is code-shaped (ECONNRESET, UND_ERR_SOCKET), else none. */
export function errorCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}
