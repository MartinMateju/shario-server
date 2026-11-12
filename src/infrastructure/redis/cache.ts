import { logger } from "@/config/logger.js";

import { redisConnection } from "./redis.js";

/*
 * A thin cache-aside layer over the shared Redis connection.
 *
 * This is a performance optimization, never a source of truth: every helper
 * here fails open. If Redis is slow, unreachable, or returns something we
 * can't parse, callers fall straight back to the real fetcher (or, for
 * invalidation, just log and move on) rather than let a cache problem turn
 * into a request hang or a failed write. The shared `redisConnection` uses a
 * finite retry budget, and the timeout below also bounds slow commands after
 * a connection has been established.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.CACHE_REDIS_TIMEOUT_MS || 200);

class CacheTimeoutError extends Error {
  constructor(ms: number) {
    super(`Redis cache operation timed out after ${ms}ms.`);
    this.name = "CacheTimeoutError";
  }
}

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number = DEFAULT_TIMEOUT_MS,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CacheTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Cache-aside read: returns the cached value for `key` if present, otherwise
 * calls `fetcher`, caches its result for `ttlSeconds`, and returns it. A
 * `fetcher` result of `null`/`undefined` is cached too (a short-lived
 * negative cache), since "this doesn't exist" is exactly as expensive to
 * keep re-querying as a positive result.
 *
 * Any Redis failure (timeout, connection error, malformed cached JSON) is
 * logged and treated as a cache miss — `fetcher` always runs in that case,
 * so a Redis outage degrades this back to "no caching," never to a broken
 * or hanging request.
 */
export const getOrSetCache = async <T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> => {
  try {
    const cached = await withTimeout(redisConnection.get(key));

    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    logger.warn(
      { err: error, cacheKey: key },
      "Cache read failed; falling back to source.",
    );
  }

  const value = await fetcher();

  try {
    await withTimeout(
      redisConnection.set(key, JSON.stringify(value), "EX", ttlSeconds),
    );
  } catch (error) {
    logger.warn(
      { err: error, cacheKey: key },
      "Cache write failed; continuing without caching this result.",
    );
  }

  return value;
};

/**
 * Deletes one cache key. Failures are logged, not thrown — callers are
 * always mid-write when they invalidate, and a cache miss on delete just
 * means the entry expires naturally via its TTL instead of immediately.
 */
export const deleteCache = async (key: string): Promise<void> => {
  try {
    await withTimeout(redisConnection.del(key));
  } catch (error) {
    logger.warn(
      { err: error, cacheKey: key },
      "Cache invalidation failed; entry will still expire via its TTL.",
    );
  }
};

/**
 * Deletes several cache keys in one round-trip. Same fail-open behavior as
 * `deleteCache`.
 */
export const deleteCacheKeys = async (
  keys: readonly string[],
): Promise<void> => {
  if (!keys.length) return;

  try {
    await withTimeout(redisConnection.del(...keys));
  } catch (error) {
    logger.warn(
      { err: error, cacheKeys: keys },
      "Cache invalidation failed; entries will still expire via their TTL.",
    );
  }
};
