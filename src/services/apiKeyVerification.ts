/**
 * Checks a caller's API key against api-auth's keyset (#154), as swaps-api and bridge-api do: poll
 * `GET /v1/keyset` with a verifier token, keep the whole active key set in memory and look each key up
 * locally, so api-auth is never on a request's path. A failed poll keeps the last good snapshot: a key
 * revoked during an api-auth outage keeps working until a poll succeeds, as on swaps-api.
 *
 * HTTP only: a stdio user has no verifier token.
 */

import { z } from "zod";
import { notifyKeysetRecovered, notifyKeysetStale } from "./discord.js";
import { errorCode, logger, redact } from "./logger.js";
import { keyHash } from "./requestContext.js";

const MODES = ["off", "monitor", "enforce"] as const;
export type KeyCheckMode = (typeof MODES)[number];

/** A well-shaped key's verdict. Missing and malformed keys never get this far (`apiKeyStatus`). */
export type KeyCheckOutcome = "ok" | "unknown_key" | "suspended" | "insufficient_scope" | "snapshot_unavailable";
/** An outcome `enforce` refuses. */
export type KeyRefusal = Exclude<KeyCheckOutcome, "ok">;

export interface KeyCheck {
  outcome: KeyCheckOutcome;
  /** Set whenever the key matched, a suspended or scope-short one included. */
  orgId?: string;
}

/** What the swap tools call: quote, allowance, approve and tokens read; intents and submit-tx write. */
export const SWAP_SCOPES = ["swaps:read", "swaps:write"] as const;

// Extra fields (prefix, tier, limits, generatedAt) are dropped; one bad entry fails the whole poll.
const entrySchema = z.object({
  keyHash: z.string(),
  keyId: z.string(),
  orgId: z.string(),
  scopes: z.array(z.string()),
  orgStatus: z.string(),
});
const keysetSchema = z.object({ version: z.string(), keys: z.array(entrySchema) });
type KeysetEntry = z.infer<typeof entrySchema>;

export interface KeysetStats {
  hasSnapshot: boolean;
  version?: string;
  keyCount: number;
  /** Since the last successful poll (a 200 or a 304); none before the first. */
  snapshotAgeMs?: number;
  consecutivePollFailures: number;
}

/** The half of the verifier a request check needs. */
export interface KeyLookup {
  hasSnapshot(): boolean;
  lookup(key: string): KeysetEntry | undefined;
}

/** `error`: a message only, redacted, never a header. */
export type PollResult = { ok: true; changed: boolean } | { ok: false; error: string };

export interface KeysetVerifier extends KeyLookup {
  /** One poll; never rejects. A call during a poll joins it. */
  refresh(): Promise<PollResult>;
  start(): void;
  stop(): void;
  stats(): KeysetStats;
}

export interface KeysetOptions {
  baseUrl: string;
  verifierToken: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Once per poll, joiners or not. */
  onPoll?: (result: PollResult, stats: KeysetStats) => void;
}

export function createKeysetVerifier(options: KeysetOptions): KeysetVerifier {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/keyset`;
  // Replaced whole, never mutated: a lookup sees the old set or the new one, never half of each.
  let snapshot: ReadonlyMap<string, KeysetEntry> | undefined;
  let version: string | undefined;
  let etag: string | undefined;
  let lastSuccessAt: number | undefined;
  let consecutivePollFailures = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<PollResult> | undefined;

  /** True when the snapshot changed. */
  const poll = async (): Promise<boolean> => {
    const response = await doFetch(url, {
      headers: {
        authorization: `Bearer ${options.verifierToken}`,
        ...(snapshot && etag ? { "if-none-match": etag } : {}),
      },
      // A redirect would carry the token to another host.
      redirect: "error",
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    if (response.status === 304) {
      if (!snapshot) throw new Error("api-auth answered 304 with no keyset held");
      return false;
    }
    if (!response.ok) {
      // Unread, the body would hold its pooled connection until GC, once per failed poll.
      await response.body?.cancel().catch(() => {});
      throw new Error(`api-auth responded ${response.status}`);
    }
    const body = await response.json().catch(() => {
      throw new Error("api-auth returned a body that isn't JSON");
    });
    const parsed = keysetSchema.safeParse(body);
    if (!parsed.success) throw new Error("api-auth returned a malformed keyset");
    const changed = parsed.data.version !== version;
    // Empty is valid: every key revoked.
    snapshot = new Map(parsed.data.keys.map(entry => [entry.keyHash, entry]));
    version = parsed.data.version;
    etag = response.headers.get("etag") ?? undefined;
    return changed;
  };

  const stats = (): KeysetStats => ({
    hasSnapshot: snapshot !== undefined,
    version,
    keyCount: snapshot?.size ?? 0,
    snapshotAgeMs: lastSuccessAt === undefined ? undefined : now() - lastSuccessAt,
    consecutivePollFailures,
  });

  const pollOnce = async (): Promise<PollResult> => {
    let result: PollResult;
    try {
      result = { ok: true, changed: await poll() };
      lastSuccessAt = now();
      consecutivePollFailures = 0;
    } catch (error) {
      consecutivePollFailures += 1;
      result = { ok: false, error: describe(error) };
    }
    options.onPoll?.(result, stats());
    return result;
  };

  // One poll at a time: two in flight could finish out of order, and the older answer would bring back a
  // revoked key. The request timeout bounds how long one holds the slot.
  const refresh = (): Promise<PollResult> => {
    inFlight ??= pollOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    refresh,
    start: () => {
      if (timer) return;
      // refresh() rejects only if onPoll throws; that must not take the server down.
      timer = setInterval(() => void refresh().catch(() => {}), options.pollIntervalMs);
      timer.unref();
    },
    stop: () => {
      clearInterval(timer);
      timer = undefined;
    },
    hasSnapshot: () => snapshot !== undefined,
    lookup: key => snapshot?.get(keyHash(key)),
    stats,
  };
}

/** A failure as a message, redacted: fetch's own is "fetch failed", its cause says why. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return redact(String(error));
  const { cause } = error;
  const why = errorCode(cause) ?? (cause instanceof Error ? cause.message : undefined);
  return redact(why ? `${error.message} (${why})` : error.message);
}

/** The keyset's verdict on a well-shaped key, in swaps-api's order; every scope in `scopes` is needed. */
export function checkApiKey(keyset: KeyLookup, key: string, scopes: readonly string[]): KeyCheck {
  if (!keyset.hasSnapshot()) return { outcome: "snapshot_unavailable" };
  const entry = keyset.lookup(key);
  if (!entry) return { outcome: "unknown_key" };
  const { orgId } = entry;
  if (entry.orgStatus === "suspended") return { outcome: "suspended", orgId };
  if (!scopes.every(scope => entry.scopes.includes(scope))) return { outcome: "insufficient_scope", orgId };
  return { outcome: "ok", orgId };
}

/** `API_KEY_ENFORCEMENT`: unset or empty is `enforce`. */
export function parseApiKeyEnforcement(value: string | undefined): KeyCheckMode {
  const mode = value?.trim().toLowerCase() || "enforce";
  const known = MODES.find(candidate => candidate === mode);
  if (!known) throw new Error('API_KEY_ENFORCEMENT must be "off", "monitor" or "enforce"');
  return known;
}

export interface KeyCheckConfig {
  mode: Exclude<KeyCheckMode, "off">;
  baseUrl: string;
  verifierToken: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The HTTP server's key check settings; none when it is off. Throws on a setting the server can't start with. */
export function parseKeyCheckConfig(env: NodeJS.ProcessEnv): KeyCheckConfig | undefined {
  const mode = parseApiKeyEnforcement(env.API_KEY_ENFORCEMENT);
  if (mode === "off") return undefined;
  const baseUrl = env.API_AUTH_URL?.trim();
  const verifierToken = env.API_AUTH_TOKEN?.trim();
  if (!baseUrl || !verifierToken) {
    throw new Error(
      `API key checks (API_KEY_ENFORCEMENT=${mode}, the default) need API_AUTH_URL and API_AUTH_TOKEN, an api-auth verifier token. Set both, or API_KEY_ENFORCEMENT=off`,
    );
  }
  // Never echoed: a URL can carry credentials.
  if (!isAuthUrl(baseUrl)) {
    throw new Error(
      "API_AUTH_URL must be an https URL without credentials, query or fragment (http only on localhost)",
    );
  }
  return {
    mode,
    baseUrl,
    verifierToken,
    pollIntervalMs: positiveMs(env, "API_AUTH_POLL_INTERVAL_MS", 15_000),
    requestTimeoutMs: positiveMs(env, "API_AUTH_POLL_TIMEOUT_MS", 5_000),
  };
}

/** https, or http on loopback; nothing after the path, which the poll extends, and no credentials fetch refuses. */
function isAuthUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname, username, password, search, hash } = new URL(value);
  if (username || password || search || hash) return false;
  return protocol === "https:" || (protocol === "http:" && LOOPBACK.has(hostname));
}

// Node's timers and AbortSignal.timeout take at most this; past it a timer fires at once.
const MAX_TIMER_MS = 2_147_483_647;

function positiveMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const ms = /^\d+$/.test(value) ? Number(value) : 0;
  if (ms <= 0 || ms > MAX_TIMER_MS) {
    throw new Error(`${name} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`);
  }
  return ms;
}

/** The running key check, as the routes and /health read it. */
export interface KeyChecker {
  readonly mode: KeyCheckConfig["mode"];
  readonly keyset: KeyLookup;
  stats(): KeysetStats;
}

/** No poll has succeeded for this long, counted from boot or the last success: one alert, one on recovery. */
export const STALE_ALERT_MS = 5 * 60_000;

/**
 * Starts polling. A failed first poll never stops the server: until one succeeds every key is
 * `snapshot_unavailable` (the swap profile gets 503 in enforce), so the builder tools stay up while api-auth
 * is down.
 */
export async function startKeyCheck(config: KeyCheckConfig, deps: { fetch?: typeof fetch } = {}): Promise<KeyChecker> {
  const startedAt = Date.now();
  let alerted = false;
  const onPoll = (result: PollResult, stats: KeysetStats) => {
    if (result.ok) {
      if (result.changed) {
        logger.info({ "keyset.version": stats.version, "keyset.key_count": stats.keyCount }, "Keyset updated");
      }
      if (alerted) {
        alerted = false;
        logger.info("Keyset polling recovered");
        void notifyKeysetRecovered();
      }
      return;
    }
    const staleMs = stats.snapshotAgeMs ?? Date.now() - startedAt;
    logger.warn(
      {
        "keyset.poll_failures": stats.consecutivePollFailures,
        "keyset.age_ms": stats.snapshotAgeMs,
        "error.message": result.error,
      },
      "Keyset poll failed",
    );
    if (!alerted && staleMs >= STALE_ALERT_MS) {
      alerted = true;
      void notifyKeysetStale(staleMs, stats.hasSnapshot, result.error);
    }
  };
  const verifier = createKeysetVerifier({ ...config, fetch: deps.fetch, onPoll });
  const first = await verifier.refresh();
  if (!first.ok) {
    logger.warn(
      { "key_check.mode": config.mode },
      "Started without an api-auth keyset: every key is snapshot_unavailable until a poll succeeds",
    );
  }
  verifier.start();
  return { mode: config.mode, keyset: verifier, stats: verifier.stats };
}
