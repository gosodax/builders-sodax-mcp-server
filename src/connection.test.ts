import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageContext, resolveConnection } from "./connection.js";
import { logger } from "./services/logger.js";

const KEY = "sodax_test-key_1";

function fakeReq(query: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return { query, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

/** Resolves a connection; `res` records what a refusal sent. */
function resolve(req: Request) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return { connection: resolveConnection(req, res as unknown as Response), res };
}

let warn: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConnection", () => {
  it.each([
    [{ profile: "swap" }, { builder: false, swap: true }],
    [{}, { builder: true, swap: true }],
  ])("forwards a SODAX key and serves its profile (%j)", (query, toolsets) => {
    const { connection, res } = resolve(fakeReq(query, { "x-api-key": KEY }));
    expect(connection).toEqual({ context: { apiKey: KEY }, toolsets });
    expect(res.status).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([`Bearer ${KEY}`, `${KEY}, ${KEY}`, "sodax_", `sodax_${"a".repeat(123)}`])(
    "refuses swap for a malformed key (%j), saying so",
    raw => {
      const { connection, res } = resolve(fakeReq({ profile: "swap" }, { "x-api-key": raw }));
      expect(connection).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: expect.stringMatching(
            /^A SODAX API key is required for the swap profile\. .* isn't a SODAX API key/,
          ),
        },
        id: null,
      });
    },
  );

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

  it("serves a default connection with a malformed key keyless, tells the client, and logs at debug only", () => {
    const { connection, res } = resolve(fakeReq({}, { "x-api-key": `Bearer ${KEY}` }));
    expect(connection?.context.apiKey).toBeUndefined();
    expect([connection?.toolsets.builder, connection?.toolsets.swap]).toEqual([true, false]);
    expect(connection?.toolsets.keyHint).toContain("isn't a SODAX API key");
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(debug.mock.calls)).not.toContain(KEY);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("doesn't log about a connection that sent no key", () => {
    const { connection } = resolve(fakeReq({}));
    expect(connection?.toolsets.keyHint).not.toContain("isn't a SODAX API key");
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("carries the connection's partner fee", () => {
    const partnerAddress = `0x${"1".repeat(40)}`;
    const { connection } = resolve(fakeReq({ partnerAddress, partnerFeeBps: "25" }));
    expect(connection?.context.partnerFee).toEqual({ address: partnerAddress, bps: 25 });
  });

  it("refuses a bad partner fee with 400, before warning about the key", () => {
    const { connection, res } = resolve(fakeReq({ partnerFeeBps: "25" }, { "x-api-key": `Bearer ${KEY}` }));
    expect(connection).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(debug).not.toHaveBeenCalled();
  });
});

describe("messageContext", () => {
  function onSession(session: { apiKey?: string }, headers: Record<string, string>) {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    return { context: messageContext(session, fakeReq({}, headers), res as unknown as Response), res };
  }

  it("runs a message with the key its session was opened with", () => {
    const { context, res } = onSession({ apiKey: KEY }, { "x-api-key": KEY });
    expect(context).toEqual({ apiKey: KEY });
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([{}, { "x-api-key": "sodax_another-key" }])(
    "refuses a keyed session's message without that key (%o), so its swap tools never run under another",
    headers => {
      const { context, res } = onSession({ apiKey: KEY }, headers);
      expect(context).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ code: -32000 }) }),
      );
    },
  );

  it("runs a keyless session's message with its own key, if any", () => {
    expect(onSession({}, {}).context).toEqual({ apiKey: undefined });
    expect(onSession({}, { "x-api-key": KEY }).context).toEqual({ apiKey: KEY });
  });
});
