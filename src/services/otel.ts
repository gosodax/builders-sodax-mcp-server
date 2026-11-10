/**
 * Unified logging (#110): the OTLP destination next to stderr. index.ts imports this module only when
 * `OTEL_LOGS_ENABLED=true`, so a deployment without it carries no OpenTelemetry code path. Every line the
 * logger writes is parsed once more and emitted as a log record: same redaction, same level, one more reader.
 * Export is batched and bounded; a gateway outage drops records, never a tool call.
 */

import { hostname } from "node:os";
import { DiagLogLevel, type LogRecord, SeverityNumber, diag } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, type LogRecordExporter, LoggerProvider } from "@opentelemetry/sdk-logs";
import { isHttpsUrl } from "../constants.js";
import { attachOtelLogs, detachOtelLogs, logger, redact } from "./logger.js";

export const DEPLOYMENT_ENVS = ["prod", "canary", "staging", "dev"] as const;
export type DeploymentEnv = (typeof DEPLOYMENT_ENVS)[number];

export interface OtelLogsConfig {
  url: string;
  token: string;
  environment: DeploymentEnv;
  origin?: string;
}

/** The settings behind `OTEL_LOGS_ENABLED=true`, or the variable that stops shipping (never its value). */
export function otelLogsConfig(env: NodeJS.ProcessEnv): OtelLogsConfig | string {
  const url = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const token = env.OTEL_LOGS_TOKEN?.trim();
  const environment = env.DEPLOYMENT_ENV?.trim() as DeploymentEnv | undefined;
  if (!environment || !DEPLOYMENT_ENVS.includes(environment)) {
    return `DEPLOYMENT_ENV must be one of ${DEPLOYMENT_ENVS.join(", ")}`;
  }
  if (!url || !URL.canParse(url)) return "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT must be the gateway's /v1/logs URL";
  // The token travels to this URL: outside a dev box it must be https.
  if (!isHttpsUrl(url) && environment !== "dev") return "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT must be an https URL";
  if (!token) return "OTEL_LOGS_TOKEN is missing";
  // The exporter would merge these into its headers and print a bad value whole; this server sends only its own.
  for (const name of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"]) {
    if (env[name]) return `${name} is set: unset it, the server sends only its own Authorization header`;
  }
  // A header can't carry anything else; the exporter would log the whole value and send none.
  if (!/^[\x21-\x7e]+$/.test(token)) return "OTEL_LOGS_TOKEN has characters a header can't carry";
  return { url, token, environment, origin: env.ORIGIN?.trim() || undefined };
}

export interface OtelLogs {
  /** One pino line. Never throws. */
  write(line: string): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface OtelLogsOptions {
  serviceVersion: string;
  /** Tests inject an in-memory exporter and a fixed instance id. */
  exporter?: LogRecordExporter;
  instanceId?: string;
}

export const SERVICE_NAME = "builders-mcp";
export const SERVICE_NAMESPACE = "builders-sodax-mcp-server";
/** On the logger records that carry the SDK's own diagnostics, which the OTLP stream skips. */
const DIAG_FIELD = "otel.diag";
const DIAG_THROTTLE_MS = 5 * 60 * 1000;

let started: OtelLogs | undefined;

/**
 * Reads the env; warns once and ships nothing when it can't, otherwise attaches the OTLP destination. A second
 * call returns the first handle: one provider, one batch queue, one thing to shut down.
 */
export function startOtelLogs(env: NodeJS.ProcessEnv, options: OtelLogsOptions): OtelLogs | undefined {
  if (started) return started;
  const config = otelLogsConfig(env);
  if (typeof config === "string") {
    logger.warn({ reason: config }, "Unified logging stays off");
    return undefined;
  }
  const otel = initOtelLogs(config, options);
  // Once shut down, the lines go back to stderr only.
  started = {
    ...otel,
    shutdown: () => {
      detachOtelLogs();
      started = undefined;
      return otel.shutdown();
    },
  };
  attachOtelLogs(started);
  logger.info({ environment: config.environment }, "Unified logging on");
  return started;
}

export function initOtelLogs(config: OtelLogsConfig, options: OtelLogsOptions): OtelLogs {
  const exporter =
    options.exporter ??
    new OTLPLogExporter({
      url: config.url,
      headers: { Authorization: `Bearer ${config.token}` },
      timeoutMillis: 10_000,
    });
  const provider = new LoggerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        "service.name": SERVICE_NAME,
        "service.namespace": SERVICE_NAMESPACE,
        "deployment.environment": config.environment,
        "service.version": options.serviceVersion,
        "service.instance.id": options.instanceId ?? hostname(),
        ...(config.origin && { "sodax.origin": config.origin }),
      }),
    ),
    logRecordLimits: { attributeValueLengthLimit: 4096, attributeCountLimit: MAX_ATTRIBUTES },
    processors: [
      new BatchLogRecordProcessor({
        exporter,
        maxQueueSize: 4096,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5_000,
        exportTimeoutMillis: 10_000,
      }),
    ],
  });
  routeDiagnostics();
  const otelLogger = provider.getLogger(SERVICE_NAME, options.serviceVersion);
  return {
    write(line) {
      try {
        const record = toLogRecord(line);
        if (record) otelLogger.emit(record);
      } catch {}
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

// A failing export complains every batch, with a body that differs each time: one line per message start per
// 5 minutes is enough to see it, and the map forgets what it said longer ago than that.
function routeDiagnostics(): void {
  const lastSaid = new Map<string, number>();
  const throttled = (...args: unknown[]) => {
    const message = redact(args.map(String).join(" "));
    const key = message.slice(0, 200);
    const now = Date.now();
    for (const [said, at] of lastSaid) if (at + DIAG_THROTTLE_MS <= now) lastSaid.delete(said);
    if (lastSaid.has(key)) return;
    lastSaid.set(key, now);
    logger.warn({ [DIAG_FIELD]: true }, `OTLP logs: ${message}`);
  };
  // Replacing a diag logger (a second init in tests) would itself log a warning.
  diag.setLogger(
    { error: throttled, warn: throttled, info: () => {}, debug: () => {}, verbose: () => {} },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  );
}

const SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};
// The resource already says where the process ran.
const DROPPED = new Set(["pid", "hostname"]);
const MAX_DEPTH = 4;
const MAX_ATTRIBUTES = 256;
// The attribute limit is the SDK's; the body has none, so it is cut here.
const MAX_BODY = 4096;
type Attributes = Record<string, string | number | boolean>;

/** The record a pino line becomes, or `undefined` for a line that isn't one. */
export function toLogRecord(line: string): LogRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { level, time, msg, err, ...rest } = parsed as Record<string, unknown>;
  if (rest[DIAG_FIELD] === true) return undefined;
  const attributes: Attributes = {};
  const flatten = flattener(attributes);
  for (const [key, value] of Object.entries(rest)) if (!DROPPED.has(key)) flatten(key, value);
  // The SDK writes exception.type/message/stacktrace from these, given a name or a message (or a bare string);
  // pino's other `err` fields keep their names. An object with neither is flattened whole instead.
  let exception: unknown;
  if (err && typeof err === "object") {
    const { type, message, stack, ...more } = err as Record<string, unknown>;
    const named = typeof type === "string" && type !== "";
    if (named || (typeof message === "string" && message !== "")) {
      exception = { name: type, message, stack };
      for (const [key, value] of Object.entries(more)) flatten(`exception.${key}`, value);
    } else {
      flatten("exception", err);
    }
  } else if (typeof err === "string" || typeof err === "number") {
    exception = err;
  }
  const severityNumber = SEVERITY[Number(level)] ?? SeverityNumber.UNSPECIFIED;
  const timestamp = new Date(time as string | number).getTime();
  return {
    timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
    severityNumber,
    severityText: SeverityNumber[severityNumber],
    body: typeof msg === "string" ? msg.slice(0, MAX_BODY) : "",
    attributes,
    exception,
  };
}

/**
 * Dotted keys with primitive leaves, what the gateway stores; arrays and anything deeper than 4 levels as JSON.
 * Stops at the SDK's attribute limit, so a wide object costs the limit and not its size.
 */
function flattener(out: Attributes): (key: string, value: unknown, depth?: number) => void {
  let left = MAX_ATTRIBUTES;
  const flatten = (key: string, value: unknown, depth = 0): void => {
    if (left <= 0 || value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value) || depth >= MAX_DEPTH) {
      out[key] = typeof value === "object" ? JSON.stringify(value) : (value as string | number | boolean);
      left--;
      return;
    }
    for (const [name, item] of Object.entries(value as Record<string, unknown>))
      flatten(`${key}.${name}`, item, depth + 1);
  };
  return flatten;
}
