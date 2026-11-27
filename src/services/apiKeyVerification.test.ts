import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type KeyLookup,
  STALE_ALERT_MS,
  checkApiKey,
  createKeysetVerifier,
  parseApiKeyEnforcement,
  parseKeyCheckConfig,
  startKeyCheck,
} from "./apiKeyVerification.js";
import { notifyKeysetRecovered, notifyKeysetStale } from "./discord.js";
import { logger } from "./logger.js";

vi.mock("./discord.js", () => ({
  notifyKeysetStale: vi.fn(async () => {}),
  notifyKeysetRecovered: vi.fn(async () => {}),
}));

const TOKEN = "verifier-token-0123456789abcdef0123456789";
const KEY = "sodax_test-key_1";
const OTHER = "sodax_test-key_2";
const URL_BASE = "https://auth.example.test/";
const INTERVAL = 15_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** An entry as api-auth sends it, extra fields included. */
function entry(key: string, fields: Record<string, unknown> = {}) {
  return {
    keyHash: sha256(key),
    keyId: `id-${key.slice(-1)}`,
    prefix: key.slice(0, 14),
    orgId: `org-${key.slice(-1)}`,
    scopes: ["swaps:read", "swaps:write", "bridge:read", "bridge:write"],
    orgStatus: "active",
    tier: "free",
    limits: {},
    ...fields,
  };
}

const keyset = (version: string, keys: unknown[]) =>
  new Response(JSON.stringify({ version, generatedAt: "2026-11-27T00:00:00.000Z", keys }), {
    status: 200,
    headers: { etag: `"${version}"` },
  });
const notModified = () => new Response(null, { status: 304 });

type Answer = Response | Error | Promise<Response>;

/** api-auth as a queue of answers, one per poll; records what each poll sent. */
function fakeApiAuth(...answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer queued");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, answers };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

const OPTIONS = { baseUrl: URL_BASE, verifierToken: TOKEN, pollIntervalMs: INTERVAL, requestTimeoutMs: 5_000 };

function verifier(api: ReturnType<typeof fakeApiAuth>, now?: () => number) {
  return createKeysetVerifier({ ...OPTIONS, fetch: api.fetch, now });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(notifyKeysetStale).mockClear();
  vi.mocked(notifyKeysetRecovered).mockClear();
});

describe("createKeysetVerifier", () => {
  it("loads the keyset with the verifier token, then sends its ETag", async () => {
    const api = fakeApiAuth(keyset("v1", [entry(KEY)]), notModified());
    const keys = verifier(api);
    expect(keys.hasSnapshot()).toBe(false);

    expect(await keys.refresh()).toEqual({ ok: true, changed: true });
    expect(keys.lookup(KEY)).toMatchObject({ orgId: "org-1", scopes: expect.arrayContaining(["swaps:write"]) });
    expect(keys.lookup(OTHER)).toBeUndefined();
    expect(api.calls[0].url).toBe("https://auth.example.test/v1/keyset");
    expect(headersOf(api.calls[0].init)).toEqual({ authorization: `Bearer ${TOKEN}` });

    expect(await keys.refresh()).toEqual({ ok: true, changed: false });
    expect(headersOf(api.calls[1].init)["if-none-match"]).toBe('"v1"');
    expect(keys.lookup(KEY)).toBeDefined();
  });

  it("refuses redirects, so the token never leaves for another host, and bounds each poll", async () => {
    const api = fakeApiAuth(keyset("v1", []));
    await verifier(api).refresh();
    expect(api.calls[0].init.redirect).toBe("error");
    expect(api.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("counts a 304 as a failure while it holds no keyset", async () => {
    const api = fakeApiAuth(notModified());
    const keys = verifier(api);
    expect(await keys.refresh()).toEqual({ ok: false, error: "api-auth answered 304 with no keyset held" });
    expect(keys.hasSnapshot()).toBe(false);
  });

  it.each([
    ["a 5xx", new Response("down", { status: 503 }), "api-auth responded 503"],
    ["a 401", new Response("no", { status: 401 }), "api-auth responded 401"],
    ["a body that isn't JSON", new Response("<html>", { status: 200 }), "api-auth returned a body that isn't JSON"],
    ["a malformed entry", keyset("v2", [{ ...entry(OTHER), scopes: "swaps:read" }]), "malformed keyset"],
    ["no keys list", new Response(JSON.stringify({ version: "v2" }), { status: 200 }), "malformed keyset"],
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timeout"],
    [
      "a refused redirect",
      Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") }),
      "fetch failed (unexpected redirect)",
    ],
  ])("keeps the last keyset through %s", async (_name, failure, error) => {
    const api = fakeApiAuth(keyset("v1", [entry(KEY)]), failure as Answer);
    const keys = verifier(api);
    await keys.refresh();

    const result = await keys.refresh();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(error);
    expect(keys.lookup(KEY)).toBeDefined();
    expect(keys.stats()).toMatchObject({ hasSnapshot: true, version: "v1", consecutivePollFailures: 1 });
  });

  it("replaces the keyset whole: a revoked key is gone, and an empty keyset revokes the last one", async () => {
    const api = fakeApiAuth(keyset("v1", [entry(KEY), entry(OTHER)]), keyset("v2", [entry(OTHER)]), keyset("v3", []));
    const keys = verifier(api);
    await keys.refresh();
    await keys.refresh();
    expect(keys.lookup(KEY)).toBeUndefined();
    expect(keys.lookup(OTHER)).toBeDefined();

    expect(await keys.refresh()).toEqual({ ok: true, changed: true });
    expect(keys.lookup(OTHER)).toBeUndefined();
    expect(keys.stats()).toMatchObject({ hasSnapshot: true, keyCount: 0, version: "v3" });
  });

  it("resets the age and the failure count on a 304 after failures", async () => {
    let now = 1_000;
    const api = fakeApiAuth(keyset("v1", [entry(KEY)]), new Response("", { status: 502 }), notModified());
    const keys = verifier(api, () => now);
    await keys.refresh();
    now += 40_000;
    await keys.refresh();
    expect(keys.stats()).toMatchObject({ snapshotAgeMs: 40_000, consecutivePollFailures: 1 });

    now += 15_000;
    expect(await keys.refresh()).toEqual({ ok: true, changed: false });
    expect(keys.stats()).toMatchObject({ snapshotAgeMs: 0, consecutivePollFailures: 0 });
  });

  it("runs one poll at a time: a refresh during a poll joins it, and the interval waits", async () => {
    vi.useFakeTimers();
    let answer: (response: Response) => void = () => {};
    const slow = new Promise<Response>(resolve => {
      answer = resolve;
    });
    const api = fakeApiAuth(slow, keyset("v2", []));
    const keys = verifier(api);
    keys.start();

    const first = keys.refresh();
    const joined = keys.refresh();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(api.fetch).toHaveBeenCalledTimes(1);

    answer(keyset("v1", [entry(KEY)]));
    expect(await first).toEqual({ ok: true, changed: true });
    expect(await joined).toEqual({ ok: true, changed: true });
    expect(keys.lookup(KEY)).toBeDefined();
    keys.stop();
  });

  it("frees the slot after a failed poll", async () => {
    const api = fakeApiAuth(new Error("ECONNREFUSED"), keyset("v1", [entry(KEY)]));
    const keys = verifier(api);
    expect((await keys.refresh()).ok).toBe(false);
    expect((await keys.refresh()).ok).toBe(true);
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps polling on the interval when onPoll throws", async () => {
    vi.useFakeTimers();
    const api = fakeApiAuth(keyset("v1", []), notModified(), notModified());
    const onPoll = vi.fn(() => {
      throw new Error("logger broke");
    });
    const keys = createKeysetVerifier({ ...OPTIONS, fetch: api.fetch, onPoll });
    keys.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onPoll).toHaveBeenCalledTimes(3);
    keys.stop();
  });

  it("cancels a failed poll's body, so it doesn't hold its connection", async () => {
    const failed = new Response("down", { status: 503 });
    const cancel = vi.spyOn(failed.body as ReadableStream, "cancel");
    await verifier(fakeApiAuth(failed)).refresh();
    expect(cancel).toHaveBeenCalled();
  });

  it("polls on the interval once started, and stops", async () => {
    vi.useFakeTimers();
    const api = fakeApiAuth(keyset("v1", []), notModified(), notModified());
    const keys = verifier(api);
    keys.start();
    keys.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    keys.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("checkApiKey", () => {
  const SWAP = ["swaps:read", "swaps:write"];
  const lookupOf = (entries: ReturnType<typeof entry>[] | undefined): KeyLookup => ({
    hasSnapshot: () => entries !== undefined,
    lookup: key => entries?.find(candidate => candidate.keyHash === sha256(key)),
  });

  it.each([
    ["snapshot_unavailable", undefined, {}],
    ["unknown_key", [entry(OTHER)], {}],
    ["suspended", [entry(KEY, { orgStatus: "suspended" })], { orgId: "org-1" }],
    ["insufficient_scope", [entry(KEY, { scopes: ["swaps:read", "bridge:write"] })], { orgId: "org-1" }],
    ["ok", [entry(KEY)], { orgId: "org-1" }],
  ])("%s", (outcome, entries, fields) => {
    expect(checkApiKey(lookupOf(entries), KEY, SWAP)).toEqual({ outcome, ...fields });
  });

  it("judges a suspended org before a missing scope", () => {
    const keys = lookupOf([entry(KEY, { orgStatus: "suspended", scopes: [] })]);
    expect(checkApiKey(keys, KEY, SWAP).outcome).toBe("suspended");
  });
});

describe("parseApiKeyEnforcement", () => {
  it.each([
    [undefined, "enforce"],
    ["", "enforce"],
    ["  ", "enforce"],
    ["off", "off"],
    [" Monitor ", "monitor"],
    ["ENFORCE", "enforce"],
  ])("%j is %s", (value, mode) => {
    expect(parseApiKeyEnforcement(value)).toBe(mode);
  });

  it.each(["on", "true", "enforced"])("refuses %j", value => {
    expect(() => parseApiKeyEnforcement(value)).toThrow('API_KEY_ENFORCEMENT must be "off", "monitor" or "enforce"');
  });
});

describe("parseKeyCheckConfig", () => {
  const env = (vars: Record<string, string | undefined>) => ({
    API_AUTH_URL: "https://auth.example.test",
    API_AUTH_TOKEN: TOKEN,
    ...vars,
  });

  it("is off with API_KEY_ENFORCEMENT=off, which needs neither URL nor token", () => {
    expect(parseKeyCheckConfig({ API_KEY_ENFORCEMENT: "off" })).toBeUndefined();
  });

  it("enforces by default, with the poll defaults", () => {
    expect(parseKeyCheckConfig(env({}))).toEqual({
      mode: "enforce",
      baseUrl: "https://auth.example.test",
      verifierToken: TOKEN,
      pollIntervalMs: 15_000,
      requestTimeoutMs: 5_000,
    });
  });

  it.each([
    [{ API_AUTH_URL: undefined }],
    [{ API_AUTH_TOKEN: " " }],
    [{ API_KEY_ENFORCEMENT: "monitor", API_AUTH_URL: "" }],
  ])("refuses to start without the URL or the token (%j), and says how to opt out", vars => {
    expect(() => parseKeyCheckConfig(env(vars))).toThrow(/API_AUTH_URL and API_AUTH_TOKEN.*API_KEY_ENFORCEMENT=off/);
  });

  it.each([
    "http://auth.example.test",
    "ftp://auth.example.test",
    "not a url",
    "https://user:secret@auth.example.test",
    "https://auth.example.test?env=prod",
    "https://auth.example.test/#keys",
  ])("refuses %s as the URL, without echoing it", url => {
    let message = "";
    try {
      parseKeyCheckConfig(env({ API_AUTH_URL: url }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^API_AUTH_URL /);
    expect(message).not.toContain(url);
  });

  it.each(["http://127.0.0.1:3122", "http://localhost:3122/", "http://[::1]:3122"])("accepts %s on loopback", url => {
    expect(parseKeyCheckConfig(env({ API_AUTH_URL: url }))?.baseUrl).toBe(url);
  });

  it("reads the poll settings", () => {
    const config = parseKeyCheckConfig(env({ API_AUTH_POLL_INTERVAL_MS: "20000", API_AUTH_POLL_TIMEOUT_MS: " 3000 " }));
    expect(config).toMatchObject({ pollIntervalMs: 20_000, requestTimeoutMs: 3_000 });
  });

  it.each(["0", "-5", "1.5", "1e3", "abc", "2147483648", "99999999999999999999"])(
    "refuses %j as a poll setting",
    value => {
      expect(() => parseKeyCheckConfig(env({ API_AUTH_POLL_INTERVAL_MS: value }))).toThrow(
        "API_AUTH_POLL_INTERVAL_MS must be a whole number of milliseconds from 1 to 2147483647",
      );
      expect(() => parseKeyCheckConfig(env({ API_AUTH_POLL_TIMEOUT_MS: value }))).toThrow(
        "API_AUTH_POLL_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647",
      );
    },
  );

  it("accepts the largest delay a timer takes", () => {
    expect(parseKeyCheckConfig(env({ API_AUTH_POLL_INTERVAL_MS: "2147483647" }))?.pollIntervalMs).toBe(2_147_483_647);
  });

  it("never puts the token in a message", () => {
    expect(() => parseKeyCheckConfig(env({ API_AUTH_URL: "http://x.test" }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }),
    );
  });
});

describe("startKeyCheck", () => {
  const config = { ...OPTIONS, mode: "enforce" as const };
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  it("starts without a keyset when the first poll fails, and checks keys once a poll succeeds", async () => {
    const api = fakeApiAuth(new Error("ECONNREFUSED"), keyset("v1", [entry(KEY)]));
    const checker = await startKeyCheck(config, { fetch: api.fetch });
    expect(checker.mode).toBe("enforce");
    expect(checkApiKey(checker.keyset, KEY, ["swaps:read"]).outcome).toBe("snapshot_unavailable");
    expect(warn).toHaveBeenCalledWith(
      { "key_check.mode": "enforce" },
      expect.stringContaining("Started without an api-auth keyset"),
    );

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(checkApiKey(checker.keyset, KEY, ["swaps:read"]).outcome).toBe("ok");
    expect(info).toHaveBeenCalledWith({ "keyset.version": "v1", "keyset.key_count": 1 }, "Keyset updated");
  });

  it("alerts once when no poll has succeeded for five minutes, and once on recovery", async () => {
    const failures = Array.from({ length: STALE_ALERT_MS / INTERVAL + 3 }, () => new Response("", { status: 503 }));
    const api = fakeApiAuth(keyset("v1", [entry(KEY)]), ...failures, notModified());
    await startKeyCheck(config, { fetch: api.fetch });

    await vi.advanceTimersByTimeAsync(STALE_ALERT_MS - INTERVAL);
    expect(notifyKeysetStale).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(notifyKeysetStale).toHaveBeenCalledTimes(1);
    expect(notifyKeysetStale).toHaveBeenCalledWith(STALE_ALERT_MS, true, "api-auth responded 503");
    expect(notifyKeysetRecovered).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(notifyKeysetRecovered).toHaveBeenCalledTimes(1);
  });

  it("counts from boot when there was never a keyset", async () => {
    const failures = Array.from({ length: STALE_ALERT_MS / INTERVAL + 1 }, () => new Error("ECONNREFUSED"));
    const api = fakeApiAuth(...failures);
    await startKeyCheck(config, { fetch: api.fetch });
    await vi.advanceTimersByTimeAsync(STALE_ALERT_MS);
    expect(notifyKeysetStale).toHaveBeenCalledWith(STALE_ALERT_MS, false, "ECONNREFUSED");
  });

  it("raises no alert while 304s keep confirming the keyset", async () => {
    const unchanged = Array.from({ length: (2 * STALE_ALERT_MS) / INTERVAL }, notModified);
    const api = fakeApiAuth(keyset("v1", [entry(KEY)]), ...unchanged);
    await startKeyCheck(config, { fetch: api.fetch });
    await vi.advanceTimersByTimeAsync(2 * STALE_ALERT_MS);
    expect(api.fetch).toHaveBeenCalledTimes(unchanged.length + 1);
    expect(notifyKeysetStale).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("never logs the token or a key", async () => {
    const api = fakeApiAuth(
      Object.assign(new TypeError("fetch failed"), { cause: new Error(`refused for Bearer ${TOKEN}`) }),
      keyset("v1", [entry(KEY)]),
      new Response(TOKEN, { status: 500 }),
    );
    await startKeyCheck(config, { fetch: api.fetch });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(sha256(KEY));
  });
});
