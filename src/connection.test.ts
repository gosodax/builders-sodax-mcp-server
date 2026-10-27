import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConnection } from "./connection.js";
import { logger } from "./services/logger.js";

const KEY = "sodax_test-key_1";

function fakeReq(query: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return { query, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

/** Resolves a connection with the switch on; `res` records what a refusal sent. */
function resolve(req: Request) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return { connection: resolveConnection(req, res as unknown as Response, true), res };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConnection", () => {
  it("forwards a SODAX key and serves its profile", () => {
    const { connection, res } = resolve(fakeReq({ profile: "swap" }, { "x-api-key": KEY }));
    expect(connection).toEqual({ apiKey: KEY, toolsets: { builder: false, swap: true } });
    expect(res.status).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([`Bearer ${KEY}`, `${KEY}, ${KEY}`, "sodax_"])("refuses swap for a malformed key (%j), saying so", raw => {
    const { connection, res } = resolve(fakeReq({ profile: "swap" }, { "x-api-key": raw }));
    expect(connection).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      error: { code: -32000, message: expect.stringContaining("isn't a SODAX API key") },
      id: null,
    });
  });

  it("refuses a keyless swap connection, asking for the header", () => {
    const { connection, res } = resolve(fakeReq({ profile: "swap" }));
    expect(connection).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error.message).toContain("Send it in the x-api-key header");
  });

  it("refuses an unknown profile with 400", () => {
    const { connection, res } = resolve(fakeReq({}, { "x-sodax-profile": "bogus" }));
    expect(connection).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Unknown profile. Use builder, swap, all." },
      id: null,
    });
  });

  it("serves a default connection with a malformed key keyless, and warns without the value", () => {
    const { connection, res } = resolve(fakeReq({}, { "x-api-key": `Bearer ${KEY}` }));
    expect(connection?.apiKey).toBeUndefined();
    expect([connection?.toolsets.builder, connection?.toolsets.swap]).toEqual([true, false]);
    expect(connection?.toolsets.swapKeyHint).toContain("isn't a SODAX API key");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("doesn't warn about a connection that sent no key", () => {
    resolve(fakeReq({}));
    expect(warn).not.toHaveBeenCalled();
  });
});
