import { afterEach, describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "@/infrastructure/lifecycle/graceful-shutdown.js";

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const silentLogger = () => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
});

describe("graceful shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks unready, stops scheduling, drains HTTP/background work, then closes dependencies in order", async () => {
    const events: string[] = [];
    const http = deferred();
    const background = deferred();
    const shutdown = createGracefulShutdown({
      markNotReady: () => events.push("not-ready"),
      stopSchedulers: () => events.push("schedulers-stopped"),
      drainSteps: [
        {
          name: "http",
          run: () => {
            events.push("http-close-started");
            return http.promise;
          },
        },
        {
          name: "jobs",
          run: () => {
            events.push("job-drain-started");
            return background.promise;
          },
        },
      ],
      cleanupSteps: [
        { name: "queue", run: () => events.push("queue-closed") },
        { name: "redis", run: () => events.push("redis-closed") },
        { name: "mongo", run: () => events.push("mongo-closed") },
      ],
      drainTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
      logger: silentLogger() as never,
    });

    const first = shutdown("SIGTERM");
    const duplicate = shutdown("SIGINT");
    expect(duplicate).toBe(first);

    for (let index = 0; index < 20 && events.length < 4; index += 1) {
      await Promise.resolve();
    }
    expect(events).toEqual([
      "not-ready",
      "schedulers-stopped",
      "http-close-started",
      "job-drain-started",
    ]);

    http.resolve();
    background.resolve();
    const result = await first;

    expect(result).toMatchObject({
      signal: "SIGTERM",
      drainTimedOut: false,
      cleanupTimedOut: [],
      errors: [],
    });
    expect(events).toEqual([
      "not-ready",
      "schedulers-stopped",
      "http-close-started",
      "job-drain-started",
      "queue-closed",
      "redis-closed",
      "mongo-closed",
    ]);
  });

  it("forces a timed-out drain and still gives later cleanup steps a bounded chance", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const never = new Promise<void>(() => undefined);
    const shutdown = createGracefulShutdown({
      markNotReady: () => events.push("not-ready"),
      stopSchedulers: () => events.push("schedulers-stopped"),
      drainSteps: [{ name: "http", run: () => never }],
      forceAfterDrainTimeout: () => events.push("http-forced"),
      cleanupSteps: [
        {
          name: "queue",
          run: () => {
            events.push("queue-close-started");
            return never;
          },
        },
        { name: "mongo", run: () => events.push("mongo-closed") },
      ],
      drainTimeoutMs: 20,
      cleanupTimeoutMs: 20,
      logger: silentLogger() as never,
    });

    const resultPromise = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    expect(result.drainTimedOut).toBe(true);
    expect(result.cleanupTimedOut).toEqual(["queue"]);
    expect(events).toEqual([
      "not-ready",
      "schedulers-stopped",
      "http-forced",
      "queue-close-started",
      "mongo-closed",
    ]);
  });

  it("bounds a hung scheduler stop and forced close before continuing cleanup", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const never = new Promise<void>(() => undefined);
    const shutdown = createGracefulShutdown({
      markNotReady: () => events.push("not-ready"),
      stopSchedulers: () => {
        events.push("scheduler-stop-started");
        return never;
      },
      drainSteps: [
        {
          name: "worker",
          run: () => {
            events.push("worker-drain-started");
            return never;
          },
        },
      ],
      forceAfterDrainTimeout: () => {
        events.push("forced-close-started");
        return never;
      },
      cleanupSteps: [
        { name: "queue", run: () => events.push("queue-closed") },
        { name: "mongo", run: () => events.push("mongo-closed") },
      ],
      drainTimeoutMs: 20,
      cleanupTimeoutMs: 30,
      logger: silentLogger() as never,
    });

    const resultPromise = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.drainTimedOut).toBe(true);
    expect(result.cleanupTimedOut).toEqual(["force-drain"]);
    expect(events).toEqual([
      "not-ready",
      "scheduler-stop-started",
      "worker-drain-started",
      "forced-close-started",
      "queue-closed",
      "mongo-closed",
    ]);
  });

  it("records a failed cleanup step and continues with the remaining dependencies", async () => {
    const failure = new Error("queue close failed");
    const mongoClose = vi.fn();
    const shutdown = createGracefulShutdown({
      markNotReady: () => undefined,
      drainSteps: [],
      cleanupSteps: [
        {
          name: "queue",
          run: () => {
            throw failure;
          },
        },
        { name: "mongo", run: mongoClose },
      ],
      logger: silentLogger() as never,
    });

    const result = await shutdown("SIGINT");

    expect(result.errors).toEqual([{ name: "queue", error: failure }]);
    expect(mongoClose).toHaveBeenCalledOnce();
  });
});
