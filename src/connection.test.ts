import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageContext, resolveConnection } from "./connection.js";
import type { KeyChecker, KeyLookup } from "./services/apiKeyVerification.js";
import { logger } from "./services/logger.js";
import type { RequestContext } from "./services/requestContext.js";

const KEY = "sodax_test-key_1";

function fakeReq(query: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return { query, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

/** A response that records what a refusal sent, and what the request's record would carry. */
function fakeRes() {
  const res = { status: vi.fn(), json: vi.fn(), locals: {} as Record<string, unknown> };
  res.status.mockReturnValue(res);
  return res;
}

/** Resolves a connection, by default with the switch on and no key check. */
function resolve(req: Request, swapToolsEnabled = true, keyChecker?: KeyChecker) {
  const res = fakeRes();
  return { connection: resolveConnection(req, res as unknown as Response, swapToolsEnabled, keyChecker), res };
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
      expect(res.locals.refusal).toBe("API_KEY_MALFORMED");
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
    expect(res.locals.refusal).toBe("API_KEY_REQUIRED");
    expect(res.json.mock.calls[0][0].error.message).toContain("Send it in the x-api-key header");
  });

  it("refuses an unknown profile with 400", () => {
    const { connection, res } = resolve(fakeReq({}, { "x-sodax-profile": "bogus" }));
    expect(connection).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(400);
    // The request's log record names the refusal.
    expect(res.locals.refusal).toBe("UNKNOWN_PROFILE");
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

  it.each([
    [{ profile: "builder" }, true],
    [{}, false],
  ])("tells a %j connection (switch on: %j) its malformed key is dropped", (query, swapToolsEnabled) => {
    const { connection } = resolve(fakeReq(query, { "x-api-key": `Bearer ${KEY}` }), swapToolsEnabled);
    expect(connection?.apiKey).toBeUndefined();
    expect(connection?.toolsets.keyHint).toMatch(
      /^The x-api-key value .* so calls go out without one\. .*https:\/\/portal\.sodax\.com/,
    );
  });

  it("doesn't log about a connection that sent no key", () => {
    const { connection } = resolve(fakeReq({}));
    expect(connection?.toolsets.keyHint).not.toContain("isn't a SODAX API key");
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  describe("with the switch off", () => {
    it("refuses the swap profile with 400, even with a SODAX key", () => {
      const { connection, res } = resolve(fakeReq({ profile: "swap" }, { "x-api-key": KEY }), false);
      expect(connection).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.locals.refusal).toBe("SWAP_PROFILE_OFF");
      expect(res.json).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        error: { code: -32602, message: "The swap profile is turned off on this server. Use builder or all." },
        id: null,
      });
    });

    it("serves a keyed default connection the builder tools only, forwarding its key", () => {
      const { connection, res } = resolve(fakeReq({}, { "x-api-key": KEY }), false);
      expect(connection).toEqual({ context: { apiKey: KEY }, toolsets: { builder: true, swap: false } });
      expect(res.status).not.toHaveBeenCalled();
    });
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
    expect(res.locals.refusal).toBe("INVALID_PARTNER_FEE");
    expect(debug).not.toHaveBeenCalled();
  });
});

describe("messageContext", () => {
  function onSession(session: { apiKey?: string }, headers: Record<string, string>) {
    const res = fakeRes();
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
      expect(res.locals.refusal).toBe("SSE_KEY_MISMATCH");
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

describe("with a key check", () => {
  const OTHER_KEY = "sodax_test-key_2";
  /** A keyset holding `held` (KEY by default), with that entry's org status and scopes; `null` is no keyset yet. */
  function checker(
    mode: "monitor" | "enforce",
    entry: { orgStatus?: string; scopes?: string[] } | null = {},
    held = KEY,
  ): KeyChecker {
    const keyset: KeyLookup = {
      hasSnapshot: () => entry !== null,
      lookup: key =>
        entry && key === held
          ? {
              keyHash: "h",
              keyId: "k",
              orgId: "org-1",
              scopes: entry.scopes ?? ["swaps:read", "swaps:write"],
              orgStatus: entry.orgStatus ?? "active",
            }
          : undefined,
    };
    return { mode, keyset, stats: () => ({ hasSnapshot: entry !== null, keyCount: 1, consecutivePollFailures: 0 }) };
  }
  const OK = { outcome: "ok", orgId: "org-1" };

  describe("resolveConnection", () => {
    it("serves a key the keyset accepts, with its verdict on the context and the record", () => {
      const { connection, res } = resolve(fakeReq({ profile: "swap" }, { "x-api-key": KEY }), true, checker("enforce"));
      expect(connection).toEqual({ context: { apiKey: KEY, keyCheck: OK }, toolsets: { builder: false, swap: true } });
      expect(res.locals.keyCheck).toEqual(OK);
    });

    it.each([
      ["an unknown key", OTHER_KEY, {}, 403, "API_KEY_UNKNOWN", { outcome: "unknown_key" }],
      [
        "a suspended org",
        KEY,
        { orgStatus: "suspended" },
        403,
        "ORG_SUSPENDED",
        { outcome: "suspended", orgId: "org-1" },
      ],
      [
        "a missing scope",
        KEY,
        { scopes: ["swaps:read"] },
        403,
        "API_KEY_SCOPE",
        { outcome: "insufficient_scope", orgId: "org-1" },
      ],
      ["no keyset yet", KEY, null, 503, "KEY_CHECK_UNAVAILABLE", { outcome: "snapshot_unavailable" }],
    ] as const)(
      "refuses swap for %s in enforce, and the record keeps the verdict",
      (_name, key, entry, status, code, check) => {
        const { connection, res } = resolve(
          fakeReq({ profile: "swap" }, { "x-api-key": key }),
          true,
          checker("enforce", entry),
        );
        expect(connection).toBeUndefined();
        expect(res.status).toHaveBeenCalledWith(status);
        expect(res.locals.refusal).toBe(code);
        expect(res.locals.keyCheck).toEqual(check);
        expect(res.json).toHaveBeenCalledWith({
          jsonrpc: "2.0",
          error: { code: -32000, message: expect.any(String) },
          id: null,
        });
        expect(JSON.stringify(res.json.mock.calls)).not.toContain(key);
      },
    );

    it("gives a default connection whose key fails the builder tools only, still forwarding its key", () => {
      const { connection, res } = resolve(fakeReq({}, { "x-api-key": OTHER_KEY }), true, checker("enforce"));
      expect(connection?.context).toEqual({ apiKey: OTHER_KEY, keyCheck: { outcome: "unknown_key" } });
      expect([connection?.toolsets.builder, connection?.toolsets.swap]).toEqual([true, false]);
      expect(connection?.toolsets.keyHint).toContain("isn't an active SODAX API key");
      expect(res.status).not.toHaveBeenCalled();
    });

    it.each([
      ["unknown_key", {}, OTHER_KEY],
      ["suspended", { orgStatus: "suspended" }, KEY],
      ["insufficient_scope", { scopes: [] }, KEY],
      ["snapshot_unavailable", null, KEY],
    ] as const)("only records a %s key in monitor", (outcome, entry, held) => {
      const keyChecker = checker("monitor", entry, held);
      const { connection, res } = resolve(fakeReq({ profile: "swap" }, { "x-api-key": KEY }), true, keyChecker);
      expect(connection?.toolsets).toEqual({ builder: false, swap: true });
      expect(connection?.context.keyCheck?.outcome).toBe(outcome);
      expect(res.status).not.toHaveBeenCalled();
    });

    it("checks no key that is missing or malformed: those keep their own refusals", () => {
      const missing = resolve(fakeReq({ profile: "swap" }), true, checker("enforce"));
      expect(missing.res.locals.refusal).toBe("API_KEY_REQUIRED");
      expect(missing.res.locals.keyCheck).toBeUndefined();
      const malformed = resolve(fakeReq({}, { "x-api-key": `Bearer ${KEY}` }), true, checker("enforce"));
      expect(malformed.connection?.context.keyCheck).toBeUndefined();
      expect(malformed.res.locals.keyCheck).toBeUndefined();
    });
  });

  describe("messageContext", () => {
    function onMessage(session: RequestContext, headers: Record<string, string>, keyChecker: KeyChecker, swap = true) {
      const res = fakeRes();
      return {
        context: messageContext(session, fakeReq({}, headers), res as unknown as Response, keyChecker, swap),
        res,
      };
    }
    const opened: RequestContext = { apiKey: KEY, keyCheck: OK };
    const revoked = (mode: "monitor" | "enforce") => checker(mode, {}, OTHER_KEY);

    it("checks each message's key again and records this message's verdict", () => {
      const { context, res } = onMessage(opened, { "x-api-key": KEY }, checker("enforce"));
      expect(context).toEqual({ apiKey: KEY, keyCheck: OK });
      expect(res.locals.keyCheck).toEqual(OK);
    });

    it("refuses a swap session's message once its key is revoked, in enforce", () => {
      const { context, res } = onMessage(opened, { "x-api-key": KEY }, revoked("enforce"));
      expect(context).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.locals.refusal).toBe("API_KEY_UNKNOWN");
      expect(res.locals.keyCheck).toEqual({ outcome: "unknown_key" });
    });

    it("refuses a swap session's message once its org is suspended, in enforce", () => {
      const { context, res } = onMessage(opened, { "x-api-key": KEY }, checker("enforce", { orgStatus: "suspended" }));
      expect(context).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.locals.refusal).toBe("ORG_SUSPENDED");
    });

    it("records, but serves, a revoked key's message in monitor", () => {
      const { context, res } = onMessage(opened, { "x-api-key": KEY }, revoked("monitor"));
      expect(context).toEqual({ apiKey: KEY, keyCheck: { outcome: "unknown_key" } });
      expect(res.status).not.toHaveBeenCalled();
    });

    it("records ok once a keyset arrives on a session opened without one", () => {
      const session: RequestContext = { apiKey: KEY, keyCheck: { outcome: "snapshot_unavailable" } };
      expect(onMessage(session, { "x-api-key": KEY }, checker("monitor")).context?.keyCheck).toEqual(OK);
    });

    it("never refuses a session without swap tools, only records", () => {
      const { context, res } = onMessage({}, { "x-api-key": OTHER_KEY }, checker("enforce"), false);
      expect(context).toEqual({ apiKey: OTHER_KEY, keyCheck: { outcome: "unknown_key" } });
      expect(res.status).not.toHaveBeenCalled();
    });

    it("keeps the key-mismatch refusal first", () => {
      const { res } = onMessage(opened, { "x-api-key": OTHER_KEY }, checker("enforce"));
      expect(res.locals.refusal).toBe("SSE_KEY_MISMATCH");
      expect(res.locals.keyCheck).toBeUndefined();
    });
  });
});
