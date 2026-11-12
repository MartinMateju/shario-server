import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  redisConstructor: vi.fn(),
  redisConnection: {
    status: "wait",
    on: vi.fn(),
    disconnect: vi.fn(),
    quit: vi.fn(),
  },
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn(function Redis(url, options) {
    mocks.redisConstructor(url, options);
    return mocks.redisConnection;
  }),
}));

describe("Redis connection reliability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails API producers fast while workers keep retrying", async () => {
    const {
      bullMqProducerConnection,
      bullMqWorkerConnection,
      redisConnection,
    } = await import("@/infrastructure/redis/redis.js");

    expect(bullMqProducerConnection).toEqual({
      url: "redis://127.0.0.1:6379",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    expect(bullMqWorkerConnection).toEqual({
      url: "redis://127.0.0.1:6379",
      maxRetriesPerRequest: null,
    });
    expect(mocks.redisConstructor).toHaveBeenCalledWith(
      "redis://127.0.0.1:6379",
      {
        keyPrefix: "shario:",
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      },
    );
    expect(redisConnection).toBe(mocks.redisConnection);
    expect(mocks.redisConnection.on).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });
});
