import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/infrastructure/redis/redis.js", () => ({
  redisConnection: {
    get: mocks.get,
    set: mocks.set,
    del: mocks.del,
  },
}));

import {
  deleteCache,
  deleteCacheKeys,
  getOrSetCache,
} from "@/infrastructure/redis/cache.js";

describe("redis cache-aside helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the cached value without calling the fetcher on a hit", async () => {
    mocks.get.mockResolvedValueOnce(JSON.stringify({ hello: "world" }));
    const fetcher = vi.fn();

    await expect(getOrSetCache("key", 30, fetcher)).resolves.toEqual({
      hello: "world",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("calls the fetcher and caches its result on a miss", async () => {
    mocks.get.mockResolvedValueOnce(null);
    mocks.set.mockResolvedValueOnce("OK");
    const fetcher = vi.fn().mockResolvedValueOnce({ answer: 42 });

    await expect(getOrSetCache("key", 30, fetcher)).resolves.toEqual({
      answer: 42,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenCalledWith(
      "key",
      JSON.stringify({ answer: 42 }),
      "EX",
      30,
    );
  });

  it("caches and correctly replays a null fetcher result (negative caching)", async () => {
    mocks.get.mockResolvedValueOnce(null); // cache miss
    mocks.set.mockResolvedValueOnce("OK");
    const fetcher = vi.fn().mockResolvedValueOnce(null);

    await expect(getOrSetCache("key", 30, fetcher)).resolves.toBeNull();
    expect(mocks.set).toHaveBeenCalledWith("key", "null", "EX", 30);

    // A subsequent hit against the literal string "null" must be
    // distinguished from ioredis's own null-for-missing-key sentinel.
    mocks.get.mockResolvedValueOnce("null");
    const secondFetcher = vi.fn();
    await expect(getOrSetCache("key", 30, secondFetcher)).resolves.toBeNull();
    expect(secondFetcher).not.toHaveBeenCalled();
  });

  it("falls back to the fetcher when the cache read fails", async () => {
    mocks.get.mockRejectedValueOnce(new Error("connection reset"));
    mocks.set.mockResolvedValueOnce("OK");
    const fetcher = vi.fn().mockResolvedValueOnce("fresh");

    await expect(getOrSetCache("key", 30, fetcher)).resolves.toBe("fresh");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("still returns the fetched value when the cache write fails", async () => {
    mocks.get.mockResolvedValueOnce(null);
    mocks.set.mockRejectedValueOnce(new Error("connection reset"));
    const fetcher = vi.fn().mockResolvedValueOnce("fresh");

    await expect(getOrSetCache("key", 30, fetcher)).resolves.toBe("fresh");
  });

  it("treats a stuck/slow redis GET as a miss rather than hanging the caller", async () => {
    vi.useFakeTimers();
    mocks.get.mockReturnValueOnce(new Promise(() => {})); // never resolves
    mocks.set.mockResolvedValueOnce("OK");
    const fetcher = vi.fn().mockResolvedValueOnce("fresh");

    const resultPromise = getOrSetCache("key", 30, fetcher);
    await vi.advanceTimersByTimeAsync(500);

    await expect(resultPromise).resolves.toBe("fresh");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not throw when a cache key fails to delete", async () => {
    mocks.del.mockRejectedValueOnce(new Error("connection reset"));

    await expect(deleteCache("key")).resolves.toBeUndefined();
  });

  it("deletes multiple keys in one call", async () => {
    mocks.del.mockResolvedValueOnce(2);

    await deleteCacheKeys(["a", "b"]);
    expect(mocks.del).toHaveBeenCalledWith("a", "b");
  });

  it("skips the redis call entirely for an empty key list", async () => {
    await deleteCacheKeys([]);
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
