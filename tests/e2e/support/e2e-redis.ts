import { assertE2ETestMode } from "@/config/e2e-mode.js";

export const E2E_REDIS_URL = "redis://127.0.0.1:6381/15";

export const resetE2ERedis = async (): Promise<void> => {
  assertE2ETestMode();
  if (process.env.REDIS_URL !== E2E_REDIS_URL) {
    throw new Error("E2E Redis reset requires the dedicated loopback database 15.");
  }
  const { redisConnection } = await import("@/infrastructure/redis/redis.js");
  if (redisConnection.options.host !== "127.0.0.1" ||
      redisConnection.options.port !== 6381 || redisConnection.options.db !== 15) {
    throw new Error("Refusing to reset a Redis connection outside E2E database 15.");
  }
  await redisConnection.ping();
  await redisConnection.flushdb("SYNC");
};
