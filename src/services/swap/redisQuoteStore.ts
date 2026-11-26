/**
 * Quotes in Redis (`REDIS_URL`), so a restart or deploy keeps them (#125). One Redis per environment, outside this
 * app's deploy unit; README, Operating the swap tools, has its settings.
 *
 * Each quote is a hash, with sorted sets beside it for what the rules ask of all quotes at once: the cap per key, the
 * store's size, the eviction order and `/health`'s count. Every change that reads before it writes is one Lua script,
 * so it's atomic. Expiry follows this server's clock, as in memory; Redis drops a quote's hash a little after it
 * expires, so the sweep can still record it if unused, and drops the indexes a day after their last write, so nothing
 * outlives a server that stopped using it. Servers sharing a Redis need their clocks in sync: the sweep and the relay
 * claim weigh time by the caller's clock.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { ErrorReply, createClient } from "@redis/client";
import { SODAX_ENV } from "../../constants.js";
import { logger } from "../logger.js";
import { ActionError } from "./errors.js";
import {
  type CachedQuote,
  HANDED_OVER_RETENTION_MS,
  type HandedOver,
  MAX_QUOTES,
  MAX_QUOTES_PER_KEY,
  type OpenQuotes,
  type QuoteStore,
  type RelayClaim,
  type Room,
  type UnusedQuote,
  deadlineMs,
  logUnused,
} from "./quoteStore.js";

// A new version for a stored shape this code can't read: the old quotes are then lost, as a restart in memory loses
// them. Per SODAX env, so a canary quote can never reach production's backend through a Redis shared by mistake.
const KEY_PREFIX = `sodax-mcp:quotes:v1:${SODAX_ENV}:`;
// How long Redis keeps a quote past its expiry, which only matters while no server sweeps: so a sweep after a long
// outage can still log an unused one. Normally the sweep deletes it within a minute of expiry.
const EXPIRY_SLACK_MS = 60 * 60 * 1000;
// Past the longest a quote is kept (a day once handed over), so an index outlives every quote written with it.
const INDEX_TTL_MS = HANDED_OVER_RETENTION_MS + EXPIRY_SLACK_MS;
// A store call that takes longer fails as unreachable: track and cancel are retried, a quote is refused.
const CALL_TIMEOUT_MS = 2_000;
const RETRY_AFTER_SEC = 30;
// Replies a Redis gives while it starts (replaying its append-only file), fails over or runs a slow script.
const TRANSIENT_REPLY = /^(LOADING|READONLY|MASTERDOWN|BUSY|TRYAGAIN)\b/;
const WARN_EVERY_MS = 60 * 1000;

// Shared by every script. ARGV[1..4]: prefix, now, expiry slack, index TTL. Indexes, by quoteId:
// all (score: expiresAt), pending (not handed over; expiresAt), unclaimed (deadline), open:<keyHash> (unclaimed, per
// key; expiresAt), ended (submitted, cancelled or closed; deadline), hubRefund (left to the hub's refund; deadline).
// `unclaimed`, `ended` and `hubRefund` are the eviction ranks, in that order.
const LUA_COMMON = `
local p, now, slack, indexTtl = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local RANK = {submitted = 'ended', cancelled = 'ended', closed = 'ended', left_to_refund = 'hubRefund'}
local STATE_INDEXES = {'pending', 'unclaimed', 'ended', 'hubRefund'}
local function k(name) return p .. name end
local function index(name, score, id)
  redis.call('ZADD', k(name), score, id)
  redis.call('PEXPIRE', k(name), indexTtl)
end
local function expireAt(id, expiresAt)
  redis.call('PEXPIRE', k('q:' .. id), math.max(expiresAt - now + slack, 1000))
end
local function drop(id)
  local f = redis.call('HMGET', k('q:' .. id), 'keyHash', 'src', 'dst')
  local unused = redis.call('ZSCORE', k('unclaimed'), id)
  redis.call('DEL', k('q:' .. id))
  redis.call('ZREM', k('all'), id)
  for _, name in ipairs(STATE_INDEXES) do redis.call('ZREM', k(name), id) end
  if f[1] then redis.call('ZREM', k('open:' .. f[1]), id) end
  return unused, f
end
local function record(out, id, reason, f)
  for _, v in ipairs({id, reason, f[1] or '', f[2] or '', f[3] or ''}) do table.insert(out, v) end
end
local function sweep(out)
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', k('all'), '-inf', now)) do
    local unused, f = drop(id)
    -- Gone from Redis already (no server swept for an hour): nothing left to say whose it was.
    if unused and f[1] then record(out, id, 'expired', f) end
  end
end
-- Handed over: no longer open, and ranked for eviction by how (relayed for refund: never).
local function setRank(id, how)
  for _, name in ipairs(STATE_INDEXES) do redis.call('ZREM', k(name), id) end
  local f = redis.call('HMGET', k('q:' .. id), 'deadlineMs', 'depositTxHash')
  -- One no deposit claimed (put back after a cancel, say) ranks as unused, as in memory.
  local rank = RANK[how]
  if not f[2] then rank = 'unclaimed' end
  if rank then index(rank, f[1], id) end
end
-- How many quotes are open (not handed over, not expired), and when the last of them expires.
local function openQuotes()
  local last = redis.call('ZRANGE', k('pending'), -1, -1, 'WITHSCORES')
  return redis.call('ZCOUNT', k('pending'), '(' .. ARGV[2], '+inf'), last[2] or '0'
end
`;

// ARGV[5..7]: keyHash, MAX_QUOTES, MAX_QUOTES_PER_KEY; to store a quote, ARGV[8] its quoteId and the hash's fields
// after. Returns {"ok" | "key" | "store", retryAt, ...unused quotes, 5 values each}.
const RESERVE = `${LUA_COMMON}
local keyHash, maxQuotes, maxPerKey = ARGV[5], tonumber(ARGV[6]), tonumber(ARGV[7])
local open = k('open:' .. keyHash)
if redis.call('ZCARD', open) >= maxPerKey then
  redis.call('ZREMRANGEBYSCORE', open, '-inf', now)
  if redis.call('ZCARD', open) >= maxPerKey then
    return {'key', redis.call('ZRANGE', open, 0, 0, 'WITHSCORES')[2]}
  end
end
local out = {'ok', '0'}
if redis.call('ZCARD', k('all')) >= maxQuotes then
  sweep(out)
  if redis.call('ZCARD', k('all')) >= maxQuotes then
    out[1] = 'store'
    for _, rank in ipairs({'unclaimed', 'ended', 'hubRefund'}) do
      local id = redis.call('ZRANGEBYSCORE', k(rank), '-inf', now, 'LIMIT', 0, 1)[1]
      if id then
        local _, f = drop(id)
        if rank == 'unclaimed' then record(out, id, 'evicted', f) end
        out[1] = 'ok'
        break
      end
    end
    if out[1] == 'store' then return out end
  end
end
if ARGV[8] then
  local id = ARGV[8]
  local q = k('q:' .. id)
  redis.call('HSET', q, unpack(ARGV, 9))
  local f = redis.call('HMGET', q, 'expiresAt', 'deadlineMs')
  local expiresAt = tonumber(f[1])
  expireAt(id, expiresAt)
  index('all', expiresAt, id)
  index('pending', expiresAt, id)
  index('unclaimed', f[2], id)
  index('open:' .. keyHash, expiresAt, id)
end
return out
`;

// ARGV[5]: quoteId.
const DISCARD = `${LUA_COMMON}
drop(ARGV[5])
return 1
`;

// ARGV[5..6]: quoteId, txHash.
const CLAIM = `${LUA_COMMON}
local id, tx = ARGV[5], ARGV[6]
local q = k('q:' .. id)
if redis.call('EXISTS', q) == 0 then return 'gone' end
local held = redis.call('HGET', q, 'depositTxHash')
if not held then
  redis.call('HSET', q, 'depositTxHash', tx)
  redis.call('ZREM', k('open:' .. redis.call('HGET', q, 'keyHash')), id)
  redis.call('ZREM', k('unclaimed'), id)
  return 'claimed'
end
if held == tx then return 'claimed' end
return 'taken'
`;

// ARGV[5]: quoteId, then fields to set if the quote is still there.
const SET_IF_PRESENT = `${LUA_COMMON}
local q = k('q:' .. ARGV[5])
if redis.call('EXISTS', q) == 0 then return 0 end
redis.call('HSET', q, unpack(ARGV, 6))
return 1
`;

// ARGV[5]: quoteId.
const SUBMITTED = `${LUA_COMMON}
local id = ARGV[5]
local q = k('q:' .. id)
if redis.call('EXISTS', q) == 0 or redis.call('HEXISTS', q, 'handedOver') == 1 then return 0 end
redis.call('HSET', q, 'handedOver', 'submitted')
setRank(id, 'submitted')
return 1
`;

// ARGV[5..7]: quoteId, how, keep until; the quote's fields after, to put it back if it was dropped. A hub outcome
// never replaces a later one (quoteStore's `outranked`): returns 0 then.
const HAND_OVER = `${LUA_COMMON}
local HUB_ORDER = {left_to_refund = 1, closed = 2, cancelled = 3}
local id, how, keepUntil = ARGV[5], ARGV[6], tonumber(ARGV[7])
local q = k('q:' .. id)
if redis.call('EXISTS', q) == 0 then
  redis.call('HSET', q, unpack(ARGV, 8))
else
  local current = redis.call('HGET', q, 'handedOver')
  if current and HUB_ORDER[current] and HUB_ORDER[how] and HUB_ORDER[how] < HUB_ORDER[current] then return 0 end
end
local expiresAt = math.max(tonumber(redis.call('HGET', q, 'expiresAt')), keepUntil)
redis.call('HSET', q, 'handedOver', how, 'expiresAt', string.format('%d', expiresAt))
expireAt(id, expiresAt)
index('all', expiresAt, id)
setRank(id, how)
return 1
`;

// ARGV[5..6]: quoteId, until. Returns "go", how it was handed over, or until when another call's relay runs.
const CLAIM_RELAY = `${LUA_COMMON}
local q = k('q:' .. ARGV[5])
if redis.call('EXISTS', q) == 0 then return 'go' end
local how = redis.call('HGET', q, 'handedOver')
if how then return how end
local busyUntil = redis.call('HGET', q, 'relayingUntil')
if busyUntil and tonumber(busyUntil) > now then return {busyUntil} end
redis.call('HSET', q, 'relayingUntil', ARGV[6])
return 'go'
`;

// ARGV[5..6]: quoteId, txHash. Returns when that tx was first tracked, or nil if the quote is gone.
const TRACKED_SINCE = `${LUA_COMMON}
local q = k('q:' .. ARGV[5])
if redis.call('EXISTS', q) == 0 then return false end
if redis.call('HGET', q, 'trackedTx') == ARGV[6] then return redis.call('HGET', q, 'trackedAt') end
redis.call('HSET', q, 'trackedTx', ARGV[6], 'trackedAt', ARGV[2])
return ARGV[2]
`;

// Returns {open, until}.
const OPEN = `${LUA_COMMON}
return {openQuotes()}
`;

// Returns {open, until, ...unused quotes, 5 values each}: the open quotes left, for the heartbeat.
const SWEEP = `${LUA_COMMON}
local out = {0, 0}
sweep(out)
out[1], out[2] = openQuotes()
return out
`;

/** The hash's `quote` field: what never changes, as JSON. The rest are fields of their own, which scripts read or set. */
type Stored = Omit<
  CachedQuote,
  | "inputAmount"
  | "minOutputAmount"
  | "keyHash"
  | "srcChainKey"
  | "dstChainKey"
  | "expiresAt"
  | "depositTxHash"
  | "handedOver"
  | "submitRefused"
  | "submitRetryAt"
  | "trackedSince"
> & { inputAmount: string; minOutputAmount: string };

function toFields(quote: CachedQuote): string[] {
  const {
    keyHash,
    srcChainKey,
    dstChainKey,
    expiresAt,
    depositTxHash,
    handedOver,
    submitRefused,
    submitRetryAt,
    trackedSince,
    ...fixed
  } = quote;
  const stored: Stored = {
    ...fixed,
    inputAmount: fixed.inputAmount.toString(),
    minOutputAmount: fixed.minOutputAmount.toString(),
  };
  const fields: Record<string, string | undefined> = {
    quote: JSON.stringify(stored),
    keyHash,
    src: srcChainKey,
    dst: dstChainKey,
    deadlineMs: String(deadlineMs(quote)),
    expiresAt: String(expiresAt),
    depositTxHash,
    handedOver,
    submitRefused: submitRefused && "1",
    submitRetryAt: submitRetryAt?.toString(),
    trackedTx: trackedSince?.txHash,
    trackedAt: trackedSince?.at.toString(),
  };
  return Object.entries(fields).flatMap(([field, value]) => (value === undefined ? [] : [field, value]));
}

function fromFields(hash: Record<string, string>): CachedQuote | undefined {
  if (!hash.quote) return undefined;
  const stored = JSON.parse(hash.quote) as Stored;
  return {
    ...stored,
    inputAmount: BigInt(stored.inputAmount),
    minOutputAmount: BigInt(stored.minOutputAmount),
    keyHash: hash.keyHash,
    srcChainKey: hash.src,
    dstChainKey: hash.dst,
    expiresAt: Number(hash.expiresAt),
    ...(hash.depositTxHash && { depositTxHash: hash.depositTxHash }),
    ...(hash.handedOver && { handedOver: hash.handedOver as HandedOver }),
    ...(hash.submitRefused && { submitRefused: true as const }),
    ...(hash.submitRetryAt && { submitRetryAt: Number(hash.submitRetryAt) }),
    ...(hash.trackedTx && { trackedSince: { txHash: hash.trackedTx, at: Number(hash.trackedAt) } }),
  };
}

function unusedFrom(reply: string[], from: number): UnusedQuote[] {
  const quotes: UnusedQuote[] = [];
  for (let i = from; i + 4 < reply.length; i += 5) {
    const [quoteId, reason, keyHash, srcChainKey, dstChainKey] = reply.slice(i, i + 5);
    quotes.push({ quoteId, reason: reason as UnusedQuote["reason"], keyHash, srcChainKey, dstChainKey });
  }
  return quotes;
}

const toOpen = (open: unknown, until: unknown): OpenQuotes => ({ open: Number(open), until: Number(until) });

/** A sweeping script's reply that came after its call timed out: the quotes it dropped are still logged. */
const logLateUnused = (reply: unknown) => logUnused(unusedFrom(reply as string[], 2));

const unreachable = () =>
  new ActionError("UPSTREAM_UNAVAILABLE", "This server can't reach its swap quote store right now.", {
    details: { retryAfterSec: RETRY_AFTER_SEC },
  });

function newClient(url: string) {
  return createClient({
    url,
    // A call while Redis is down fails at once instead of waiting in a queue for it to come back.
    disableOfflineQueue: true,
    socket: { connectTimeout: 5_000, reconnectStrategy: retries => Math.min(100 * 2 ** retries, 5_000) },
  });
}

type Client = ReturnType<typeof newClient>;

export class RedisQuoteStore implements QuoteStore {
  readonly kind = "redis";
  private lastOpen?: OpenQuotes;
  private lastWarningAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly client: Client,
    private readonly prefix: string,
  ) {}

  /**
   * A store call, or `unreachable`: it never waits for a Redis that's down or slow. Redis may still run a call that
   * timed out; `late` gets its reply then.
   */
  private async call<T>(op: () => Promise<T>, late?: (reply: T) => void): Promise<T> {
    if (!this.client.isReady) throw unreachable();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No reply within ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS);
    });
    let reply: Promise<T> | undefined;
    try {
      reply = op();
      return await Promise.race([reply, timeout]);
    } catch (error) {
      // Redis answered with an error (a script bug, a full Redis, a key of another type): not an outage, and it
      // won't pass by itself, so it's logged every time and alerts. A Redis loading its data or failing over will.
      if (error instanceof ErrorReply && !TRANSIENT_REPLY.test(error.message)) {
        logger.error({ err: error }, "The swap quote store refused a call");
        throw new ActionError("INTERNAL", "The swap quote store refused a call.");
      }
      if (late) reply?.then(late, () => {});
      this.warn(error, "A swap quote store call failed");
      throw unreachable();
    } finally {
      clearTimeout(timer);
    }
  }

  private run(
    script: string,
    now: number,
    args: (string | number)[],
    late?: (reply: unknown) => void,
  ): Promise<unknown> {
    const argv = [this.prefix, now, EXPIRY_SLACK_MS, INDEX_TTL_MS, ...args].map(String);
    return this.call(() => this.client.eval(script, { arguments: argv }), late);
  }

  /** Once a minute at most: a Redis that's down fails every call, and the client retries every few seconds. */
  warn(error: unknown, message: string): void {
    const now = Date.now();
    if (now - this.lastWarningAt < WARN_EVERY_MS) return;
    this.lastWarningAt = now;
    logger.warn({ err: error }, message);
  }

  async reserve(keyHash: string, now: number, quote?: CachedQuote): Promise<Room> {
    const put = quote ? [quote.quoteId, ...toFields(quote)] : [];
    const args = [keyHash, MAX_QUOTES, MAX_QUOTES_PER_KEY, ...put];
    const reply = (await this.run(RESERVE, now, args, logLateUnused)) as string[];
    if (reply[0] === "key") return { full: "key", retryAt: Number(reply[1]), unused: [] };
    const unused = unusedFrom(reply, 2);
    return reply[0] === "store" ? { full: "store", unused } : { unused };
  }

  async get(quoteId: string): Promise<CachedQuote | undefined> {
    return fromFields(await this.call(() => this.client.hGetAll(`${this.prefix}q:${quoteId}`)));
  }

  async discard(quoteId: string): Promise<void> {
    await this.run(DISCARD, Date.now(), [quoteId]);
  }

  async claim(quoteId: string, txHash: string): Promise<"claimed" | "taken" | "gone"> {
    return (await this.run(CLAIM, Date.now(), [quoteId, txHash])) as "claimed" | "taken" | "gone";
  }

  async set(quoteId: string, { submitRetryAt, submitRefused }: Pick<CachedQuote, "submitRetryAt" | "submitRefused">) {
    const fields = [
      ...(submitRetryAt === undefined ? [] : ["submitRetryAt", submitRetryAt]),
      ...(submitRefused ? ["submitRefused", "1"] : []),
    ];
    if (fields.length > 0) await this.run(SET_IF_PRESENT, Date.now(), [quoteId, ...fields]);
  }

  async setSubmitted(quoteId: string): Promise<void> {
    await this.run(SUBMITTED, Date.now(), [quoteId]);
  }

  async handOver(quote: CachedQuote & { handedOver: HandedOver }, now: number): Promise<void> {
    await this.run(HAND_OVER, now, [quote.quoteId, quote.handedOver, quote.expiresAt, ...toFields(quote)]);
  }

  async claimRelay(quoteId: string, now: number, until: number): Promise<RelayClaim> {
    const reply = (await this.run(CLAIM_RELAY, now, [quoteId, until])) as string | string[];
    return Array.isArray(reply) ? { busyUntil: Number(reply[0]) } : (reply as RelayClaim);
  }

  async releaseRelay(quoteId: string): Promise<void> {
    await this.call(() => this.client.hDel(`${this.prefix}q:${quoteId}`, "relayingUntil"));
  }

  async trackedSince(quoteId: string, txHash: string, now: number): Promise<number | undefined> {
    const at = await this.run(TRACKED_SINCE, now, [quoteId, txHash]);
    return at === null ? undefined : Number(at);
  }

  async open(now: number): Promise<OpenQuotes> {
    const [open, until] = await this.read(OPEN, now);
    return toOpen(open, until);
  }

  /**
   * A script whose reply starts with the open quotes, kept for the heartbeat; after a failed read it says nothing
   * rather than a count from before an outage.
   */
  private async read(script: string, now: number): Promise<string[]> {
    try {
      const reply = (await this.run(script, now, [], logLateUnused)) as string[];
      this.lastOpen = toOpen(reply[0], reply[1]);
      return reply;
    } catch (error) {
      this.lastOpen = undefined;
      throw error;
    }
  }

  openNow(): OpenQuotes | undefined {
    return this.lastOpen;
  }

  async sweep(now: number): Promise<UnusedQuote[]> {
    return unusedFrom(await this.read(SWEEP, now), 2);
  }

  async clear(): Promise<void> {
    for await (const keys of this.client.scanIterator({ MATCH: `${this.prefix}*`, COUNT: 500 })) {
      if (keys.length > 0) await this.client.del(keys);
    }
  }

  /** Once Redis first answers, or after `ms` without it: a server still starts with Redis down. */
  ready(ms: number): Promise<void> {
    if (this.client.isReady) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.client.off("ready", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.client.once("ready", done);
    });
  }

  /** Waits for the calls in flight, as long as one may take; one that's still connecting stops trying. */
  async close(): Promise<void> {
    if (this.client.isReady) {
      const closed = this.client.close().then(
        () => true,
        () => true,
      );
      // A Redis that stopped answering would hold the close, and the process, open.
      if (!(await Promise.race([closed, sleep(CALL_TIMEOUT_MS, false, { ref: false })]))) this.client.destroy();
    } else if (this.client.isOpen) this.client.destroy();
  }
}

/**
 * A store on `url`, connecting in the background: until Redis answers, swap calls fail as unreachable, and nothing
 * falls back to memory. The client reconnects for as long as the server runs.
 */
export function connectRedisQuoteStore(url: string, prefix = KEY_PREFIX): RedisQuoteStore {
  const client = newClient(url);
  const store = new RedisQuoteStore(client, prefix);
  // Without a listener, a connection error would be thrown as an uncaught exception and stop the server.
  client.on("error", error => store.warn(error, "The swap quote store's connection failed"));
  client.on("ready", () => logger.info("Connected to the swap quote store"));
  // Settles only once connected, or when closed: until then each failure comes through the listener above.
  client.connect().catch(() => {});
  return store;
}
