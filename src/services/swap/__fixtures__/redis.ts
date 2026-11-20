/**
 * A real Redis for the quote store's tests: CI starts one and sets `REDIS_TEST_URL`; locally it opts in. Each store
 * gets its own key prefix, so test files never share keys.
 */

import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { MemoryQuoteStore } from "../memoryQuoteStore.js";
import { useQuoteStore } from "../quoteCache.js";
import { type RedisQuoteStore, connectRedisQuoteStore } from "../redisQuoteStore.js";

const url = process.env.REDIS_TEST_URL;
if (process.env.CI && !url) throw new Error("Set REDIS_TEST_URL: CI tests the Redis quote store too");

/** For `describe.each`: the Redis to test against, or none. */
export const REDIS_URLS = url ? [url] : [];

/** A store on `url` once Redis answers it, or the test fails. */
export async function openRedisStore(url: string, prefix = `test:${randomUUID()}:`) {
  const store = connectRedisQuoteStore(url, prefix);
  await vi.waitFor(() => store.open(Date.now()), { timeout: 5_000, interval: 50 });
  return store;
}

/** Servers on one Redis, as a deploy or a second server brings up: every store `open` gives shares `prefix`. */
export function redisServers(url: string) {
  const prefix = `test:${randomUUID()}:`;
  const opened: RedisQuoteStore[] = [];
  return {
    prefix,
    async open() {
      const store = await openRedisStore(url, prefix);
      opened.push(store);
      return store;
    },
    /** For `afterAll`: deletes the keys, closes every store and puts a memory store back. */
    async closeAll() {
      await opened.at(-1)?.clear();
      await Promise.all(opened.map(store => store.close()));
      useQuoteStore(new MemoryQuoteStore());
    },
  };
}
