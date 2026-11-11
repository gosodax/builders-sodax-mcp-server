import { readFileSync } from "node:fs";
import { SeverityNumber, diag } from "@opentelemetry/api";
import { InMemoryLogRecordExporter, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLogger, detachOtelLogs, logger, redactErr } from "./logger.js";
import {
  type OtelLogs,
  type OtelLogsConfig,
  initOtelLogs,
  otelLogsConfig,
  startOtelLogs,
  toLogRecord,
} from "./otel.js";
import { runWithRequestContext } from "./requestContext.js";

const ENV = {
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example/v1/logs",
  OTEL_LOGS_TOKEN: "secret-token",
  DEPLOYMENT_ENV: "staging",
  ORIGIN: "box-1",
};
const CONFIG: OtelLogsConfig = {
  url: ENV.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  token: ENV.OTEL_LOGS_TOKEN,
  environment: "staging",
  origin: "box-1",
};
const time = "2026-11-10T01:02:03.004Z";
const line = (fields: Record<string, unknown>) => JSON.stringify({ level: 30, time, msg: "m", ...fields });

// Every handle made here is shut down after its test, whatever the assertions did.
const handles: OtelLogs[] = [];
const stubExporter = (exportFn: LogRecordExporter["export"]): LogRecordExporter => ({
  export: exportFn,
  shutdown: async () => {},
  forceFlush: async () => {},
});
function shipping(exporter: LogRecordExporter = new InMemoryLogRecordExporter()) {
  const otel = initOtelLogs(CONFIG, { serviceVersion: "1.2.3", exporter, instanceId: "test-1" });
  handles.push(otel);
  return { exporter: exporter as InMemoryLogRecordExporter, otel };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  detachOtelLogs();
  diag.disable();
  for (const otel of handles.splice(0))
    await Promise.race([otel.shutdown().catch(() => {}), new Promise(r => setTimeout(r, 50))]);
});

describe("otelLogsConfig", () => {
  it("takes the gateway URL, the token, the environment and the origin", () => {
    expect(otelLogsConfig(ENV)).toEqual(CONFIG);
    expect(otelLogsConfig({ ...ENV, ORIGIN: undefined })).toMatchObject({ origin: undefined });
  });

  it.each([
    [{ ...ENV, DEPLOYMENT_ENV: "production" }, "DEPLOYMENT_ENV"],
    [{ ...ENV, OTEL_LOGS_TOKEN: " " }, "OTEL_LOGS_TOKEN"],
    [{ ...ENV, OTEL_LOGS_TOKEN: "secret-token with a space" }, "OTEL_LOGS_TOKEN"],
    [{ ...ENV, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "not a url secret-token" }, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"],
    [{ ...ENV, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://otel.example/v1/logs" }, "https"],
    [{ ...ENV, OTEL_EXPORTER_OTLP_HEADERS: "x-extra=secret-token" }, "OTEL_EXPORTER_OTLP_HEADERS"],
    [{ ...ENV, OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-extra=secret-token" }, "OTEL_EXPORTER_OTLP_LOGS_HEADERS"],
  ])("names what is wrong and never a value", (env, word) => {
    const reason = otelLogsConfig(env);
    expect(typeof reason).toBe("string");
    expect(reason).toContain(word);
    expect(reason).not.toContain("secret-token");
  });

  it("takes the gateway's base URL too, as the backend's variable holds it", () => {
    for (const base of ["https://otel.example", "https://otel.example/"]) {
      expect(otelLogsConfig({ ...ENV, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: base })).toEqual(CONFIG);
    }
  });

  it("allows a plain http endpoint on a dev box only", () => {
    const env = { ...ENV, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs", DEPLOYMENT_ENV: "dev" };
    expect(otelLogsConfig(env)).toMatchObject({ environment: "dev" });
  });
});

describe("toLogRecord", () => {
  it("maps a pino line: time, level, message, flat attributes", () => {
    const full = JSON.stringify({
      level: 40,
      time,
      pid: 1,
      hostname: "h",
      msg: "Tool call",
      "gen_ai.tool.name": "x",
      "request.id": "r1",
      n: 2,
      ok: true,
    });
    expect(toLogRecord(`${full}\n`)).toEqual({
      timestamp: Date.parse(time),
      severityNumber: SeverityNumber.WARN,
      severityText: "warn",
      body: "Tool call",
      attributes: { "gen_ai.tool.name": "x", "request.id": "r1", n: 2, ok: true },
      exception: undefined,
    });
  });

  it("hands the error to the SDK as the exception, and flattens its other fields under exception.*", () => {
    const err = redactErr(
      Object.assign(new Error("boom https://rpc.example/key"), { code: 7, cause: { status: 500 } }),
    );
    const record = toLogRecord(JSON.stringify({ level: 50, time, msg: "Swap tool failed", err }));
    expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record?.exception).toMatchObject({ name: "Error", message: "boom <url>" });
    expect((record?.exception as { stack: string }).stack).toContain("Error: boom");
    expect(record?.attributes).toEqual({ "exception.code": 7, "exception.cause.status": 500 });
  });

  it("flattens an error that has no name and no message, and passes a bare string error on", () => {
    expect(toLogRecord(line({ err: { code: "ETIMEDOUT", status: 504 } }))).toMatchObject({
      exception: undefined,
      attributes: { "exception.code": "ETIMEDOUT", "exception.status": 504 },
    });
    expect(toLogRecord(line({ err: "balance read failed" }))?.exception).toBe("balance read failed");
  });

  it("flattens nested objects to dotted keys, stringifies arrays, and stops at the attribute limit", () => {
    expect(toLogRecord(line({ a: { b: { c: 1 } }, list: [1, "x"], rows: [{ k: 1 }] }))?.attributes).toEqual({
      "a.b.c": 1,
      list: '[1,"x"]',
      rows: '[{"k":1}]',
    });
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    const cut = toLogRecord(line({ wide: keys(1000) }))?.attributes ?? {};
    expect(Object.keys(cut)).toHaveLength(253);
    expect(cut["log.attributes_truncated"]).toBe(true);
    // Exactly the budget, then nothing more to add: not cut.
    const exact = toLogRecord(line({ wide: keys(252), empty: {}, nulls: { a: null } }))?.attributes ?? {};
    expect(Object.keys(exact)).toHaveLength(252);
    expect(exact).not.toHaveProperty("log.attributes_truncated");
  });

  it("cuts the body at 4 KB and falls back to now without a usable time", () => {
    expect((toLogRecord(line({ msg: "m".repeat(5000) }))?.body as string).length).toBe(4096);
    const before = Date.now();
    expect(toLogRecord(JSON.stringify({ level: 30, msg: "m" }))?.timestamp as number).toBeGreaterThanOrEqual(before);
  });

  it("ignores a line that isn't a JSON object, and the SDK's own diagnostics", () => {
    expect(toLogRecord("not json")).toBeUndefined();
    expect(toLogRecord("[1]")).toBeUndefined();
    expect(toLogRecord(line({ msg: "OTLP logs: export failed", "otel.diag": true }))).toBeUndefined();
  });
});

describe("initOtelLogs", () => {
  it("exports records with the gateway's required resource attributes, the exception mapped by the SDK", async () => {
    const { exporter, otel } = shipping();
    otel.write(line({ msg: "hello", "gen_ai.tool.name": "x" }));
    otel.write(
      JSON.stringify({ level: 50, time, msg: "failed", err: redactErr(new Error("x https://rpc.example/k")) }),
    );
    await otel.forceFlush();
    const [hello, failed] = exporter.getFinishedLogRecords();
    expect(hello.resource.attributes).toMatchObject({
      "service.name": "builders-mcp",
      "service.namespace": "builders-sodax-mcp-server",
      "deployment.environment": "staging",
      "service.version": "1.2.3",
      "service.instance.id": "test-1",
      "sodax.origin": "box-1",
      "telemetry.sdk.name": "opentelemetry",
    });
    expect(hello.body).toBe("hello");
    expect(hello.severityNumber).toBe(SeverityNumber.INFO);
    expect(hello.attributes).toEqual({ "gen_ai.tool.name": "x" });
    expect(failed.attributes).toMatchObject({ "exception.type": "Error", "exception.message": "x <url>" });
    expect(failed.attributes["exception.stacktrace"]).toContain("Error: x");
  });

  it("cuts long attribute values at 4 KB", async () => {
    const { exporter, otel } = shipping();
    otel.write(line({ long: "a".repeat(5000) }));
    await otel.forceFlush();
    expect((exporter.getFinishedLogRecords()[0].attributes.long as string).length).toBe(4096);
  });

  it("keeps the exception's attributes on a record so wide its fields were cut", async () => {
    const { exporter, otel } = shipping();
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    otel.write(JSON.stringify({ level: 50, time, msg: "failed", err: redactErr(new Error("boom")), wide }));
    await otel.forceFlush();
    const [record] = exporter.getFinishedLogRecords();
    expect(record.attributes).toMatchObject({
      "exception.type": "Error",
      "exception.message": "boom",
      "log.attributes_truncated": true,
    });
    expect(record.attributes["exception.stacktrace"]).toContain("Error: boom");
  });

  it("counts the records written, the ones the gateway took and the ones it lost, for /health", async () => {
    const { otel } = shipping();
    otel.write(line({ a: 1 }));
    otel.write(line({ a: 2 }));
    otel.write("not a record");
    await otel.forceFlush();
    expect(otel.stats()).toEqual({ written: 2, exported: 2, failed: 0, lastFailureAt: null });
    const lost = shipping(stubExporter((_logs, done) => done({ code: 1, error: new Error("503") }))).otel;
    lost.write(line({ a: 3 }));
    await lost.forceFlush();
    expect(lost.stats()).toEqual({ written: 1, exported: 0, failed: 1, lastFailureAt: expect.any(String) });
  });

  it("never throws, not on a bad line and not with an exporter that never answers", () => {
    const { otel } = shipping(stubExporter(() => {}));
    expect(() => {
      otel.write("not json\n");
      for (let i = 0; i < 5000; i++) otel.write(line({ i }));
    }).not.toThrow();
  });

  it("passes the SDK's diagnostics to the logger once per message per five minutes, redacted and tagged", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn");
    shipping();
    diag.error("export failed", "https://otel.example/v1/logs?token=secret");
    diag.error("export failed", "https://otel.example/v1/logs?token=secret");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ "otel.diag": true }, "OTLP logs: export failed <url>");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    diag.error("export failed", "https://otel.example/v1/logs?token=secret");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("startOtelLogs", () => {
  it("warns once and ships nothing when a setting is wrong", () => {
    const warn = vi.spyOn(logger, "warn");
    expect(startOtelLogs({ ...ENV, DEPLOYMENT_ENV: "production" }, { serviceVersion: "1" })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { reason: expect.stringContaining("DEPLOYMENT_ENV") },
      "Unified logging stays off",
    );
  });

  it("ships what the logger writes through pino's streamWrite hook, request id included, until shut down", async () => {
    const info = vi.spyOn(logger, "info");
    const exporter = new InMemoryLogRecordExporter();
    const otel = startOtelLogs(ENV, { serviceVersion: "1", exporter });
    expect(otel).toBeDefined();
    if (!otel) return;
    handles.push(otel);
    expect(info).toHaveBeenCalledWith({ environment: "staging" }, "Unified logging on");
    expect(startOtelLogs(ENV, { serviceVersion: "1", exporter })).toBe(otel);
    // The same options as the singleton (its hook included); the singleton itself is silent under vitest.
    const log = buildLogger({ write: () => {} }, { level: "info" });
    runWithRequestContext({ requestId: "req-1" }, () => log.warn({ "chain.key": "sonic" }, "Chain read"));
    log.info("outside");
    await otel.forceFlush();
    const [inside, outside, ...more] = exporter.getFinishedLogRecords();
    expect(more).toEqual([]);
    expect(inside.severityText).toBe("warn");
    expect(inside.attributes).toEqual({ "request.id": "req-1", "chain.key": "sonic" });
    expect(outside.attributes).not.toHaveProperty("request.id");
    // Shut down, the hook no longer reaches it.
    const write = vi.spyOn(otel, "write");
    await otel.shutdown();
    log.info("after shutdown");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("the heartbeat", () => {
  it("ships the export counts through the logger every five minutes whatever the log level, and stops at shutdown", async () => {
    vi.useFakeTimers();
    const timersBefore = vi.getTimerCount();
    const exporter = new InMemoryLogRecordExporter();
    // The logger is silent under vitest, so a record that reaches the exporter passed the hook at its own level.
    const otel = startOtelLogs(ENV, { serviceVersion: "1", exporter });
    expect(otel).toBeDefined();
    if (!otel) return;
    handles.push(otel);
    const beats = async () => {
      await otel.forceFlush();
      return exporter.getFinishedLogRecords().filter(record => record.body === "Unified logging heartbeat");
    };
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(await beats()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const [beat, ...more] = await beats();
    expect(more).toEqual([]);
    expect(beat.severityText).toBe("info");
    expect(beat.attributes).toEqual({
      "unified_logging.written": expect.any(Number),
      "unified_logging.exported": expect.any(Number),
      "unified_logging.failed": 0,
    });
    await otel.shutdown();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});

describe("a late shutdown", () => {
  it("of a handle already replaced leaves the newer one attached", async () => {
    const first = startOtelLogs(ENV, { serviceVersion: "1", exporter: new InMemoryLogRecordExporter() });
    if (!first) throw new Error("not started");
    await first.shutdown();
    const exporter = new InMemoryLogRecordExporter();
    const second = startOtelLogs(ENV, { serviceVersion: "1", exporter });
    if (!second) throw new Error("not started");
    handles.push(second);
    await first.shutdown();
    expect(startOtelLogs(ENV, { serviceVersion: "1", exporter })).toBe(second);
    const write = vi.spyOn(second, "write");
    buildLogger({ write: () => {} }, { level: "info" }).info("still shipped");
    expect(write).toHaveBeenCalled();
  });
});

describe("the OTel modules stay unloaded without OTEL_LOGS_ENABLED", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("logger.ts imports only a type, and index.ts imports otel.js only behind the gate", () => {
    const loggerSource = source("./logger.js".replace(".js", ".ts"));
    expect(loggerSource.match(/from "\.\/otel\.js"/g)).toHaveLength(1);
    expect(loggerSource).toMatch(/import type \{[^}]*\} from "\.\/otel\.js"/);
    const indexSource = source("../index.ts");
    const uses = indexSource.match(/[^\n]*services\/otel\.js[^\n]*/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(uses[0]).toMatch(/^import type /);
    expect(uses[1]).toMatch(/await import\("\.\/services\/otel\.js"\)/);
    const gate = indexSource.indexOf('process.env.OTEL_LOGS_ENABLED === "true"');
    expect(gate).toBeGreaterThan(0);
    expect(indexSource.indexOf(uses[1])).toBeGreaterThan(gate);
  });
});
