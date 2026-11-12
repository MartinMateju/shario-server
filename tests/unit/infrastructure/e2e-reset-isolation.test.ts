import { EventEmitter } from "node:events";
import http from "node:http";
import compression from "compression";
import express from "express";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({
  options: { host: "127.0.0.1", port: 6381, db: 15 },
  ping: vi.fn(),
  flushdb: vi.fn(),
}));
vi.mock("@/infrastructure/redis/redis.js", () => ({ redisConnection: redis }));

import { createE2ERequestBarrier } from "../../e2e/support/e2e-request-barrier.js";
import { E2E_REDIS_URL, resetE2ERedis } from "../../e2e/support/e2e-redis.js";

const response = () => {
  const res = new EventEmitter() as EventEmitter & Response;
  res.end = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};
const request = { method: "GET", path: "/bookings/mine" } as Request;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("E2E_TEST_MODE", "true");
  vi.stubEnv("REDIS_URL", E2E_REDIS_URL);
  Object.assign(redis.options, { host: "127.0.0.1", port: 6381, db: 15 });
  redis.ping.mockReset().mockResolvedValue("PONG");
  redis.flushdb.mockReset().mockResolvedValue("OK");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("E2E reset isolation", () => {
  it("drains handlers before reset, even when their browser socket closes", async () => {
    const barrier = createE2ERequestBarrier();
    const first = response();
    barrier.middleware(request, first, vi.fn());
    const reset = vi.fn().mockResolvedValue("fresh fixtures");
    const pending = barrier.runReset(reset);
    expect(reset).not.toHaveBeenCalled();

    const late = response();
    const next = vi.fn();
    barrier.middleware(request, late, next);
    expect(late.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    first.emit("close");
    await Promise.resolve();
    expect(reset).not.toHaveBeenCalled();

    first.end();
    first.emit("finish"); // completion is counted only once
    expect(await pending).toBe("fresh fixtures");
    expect(reset).toHaveBeenCalledTimes(1);
    const fresh = response();
    barrier.middleware(request, fresh, next);
    expect(next).toHaveBeenCalledTimes(1);
    fresh.end();
  });

  it("refuses to clear fixtures when a handler does not drain in time", async () => {
    vi.useFakeTimers();
    const barrier = createE2ERequestBarrier(20);
    const stalled = response();
    barrier.middleware(request, stalled, vi.fn());
    const reset = vi.fn();
    const pending = expect(barrier.runReset(reset)).rejects.toThrow("did not drain");
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(reset).not.toHaveBeenCalled();
    stalled.end();
    await barrier.runReset(reset);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("drains a completed gzip handler after its client disconnects", async () => {
    const barrier = createE2ERequestBarrier(1_000);
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    let complete!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { complete = resolve; });
    const app = express();
    // Match createApp: tracking must wrap compression's end(), since it may
    // discard a gzip stream on socket close without calling the raw end().
    app.use(compression());
    app.use(barrier.middleware);
    app.get("/pending-write", async (_req, res) => {
      started();
      await pendingWrite;
      res.json({ value: "x".repeat(10_000) });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const client = http.get(`http://127.0.0.1:${address.port}/pending-write`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    client.on("error", () => {});
    try {
      await admitted;
      const reset = vi.fn().mockResolvedValue(undefined);
      const resetting = barrier.runReset(reset);
      const closed = new Promise<void>((resolve) => client.once("close", resolve));
      client.destroy();
      await closed;
      expect(reset).not.toHaveBeenCalled();
      complete();
      await resetting;
      expect(reset).toHaveBeenCalledOnce();
    } finally {
      complete();
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps new requests blocked until reset finishes and reopens after reset failure", async () => {
    const barrier = createE2ERequestBarrier();
    let reject!: (error: Error) => void;
    const pending = barrier.runReset(() => new Promise((_, fail) => { reject = fail; }));
    const failure = expect(pending).rejects.toThrow("seed failed");
    const next = vi.fn();
    barrier.middleware(request, response(), next);
    expect(next).not.toHaveBeenCalled();
    reject(new Error("seed failed"));
    await failure;
    const fresh = response();
    barrier.middleware(request, fresh, next);
    expect(next).toHaveBeenCalledOnce();
    fresh.end();
  });

  it("lets the guarded reset route reach its own authorization and reset queue", () => {
    const barrier = createE2ERequestBarrier();
    const next = vi.fn();
    barrier.middleware({ method: "POST", path: "/__e2e/reset" } as Request, response(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("isolated E2E Redis reset", () => {
  it("checks reachability and clears only the guarded selected database", async () => {
    await resetE2ERedis();
    expect(redis.ping).toHaveBeenCalledOnce();
    expect(redis.flushdb).toHaveBeenCalledExactlyOnceWith("SYNC");
  });

  it.each([
    ["NODE_ENV", "production"],
    ["E2E_TEST_MODE", "false"],
    ["REDIS_URL", "redis://127.0.0.1:6379/0"],
    ["REDIS_URL", "redis://remote.test:6379/15"],
  ])("refuses unsafe %s=%s before touching Redis", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(resetE2ERedis()).rejects.toThrow();
    expect(redis.ping).not.toHaveBeenCalled();
    expect(redis.flushdb).not.toHaveBeenCalled();
  });

  it.each([{ db: 0 }, { host: "remote.test" }, { port: 6380 }])(
    "rejects an already-created connection with unsafe options %j",
    async (options) => {
      Object.assign(redis.options, options);
      await expect(resetE2ERedis()).rejects.toThrow("outside E2E database 15");
      expect(redis.flushdb).not.toHaveBeenCalled();
    },
  );

  it("does not clear anything when Redis is unavailable", async () => {
    redis.ping.mockRejectedValueOnce(new Error("unavailable"));
    await expect(resetE2ERedis()).rejects.toThrow("unavailable");
    expect(redis.flushdb).not.toHaveBeenCalled();
  });
});
