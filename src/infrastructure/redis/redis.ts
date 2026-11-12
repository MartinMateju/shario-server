import type { ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";

import { logger } from "@/config/logger.js";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("Missing REDIS_URL environment variable.");
}

export const bullMqPrefix = "shario";

export const bullMqProducerConnection: ConnectionOptions = {
  url: redisUrl,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
};

export const bullMqWorkerConnection: ConnectionOptions = {
  url: redisUrl,
  maxRetriesPerRequest: null,
};

export const redisConnection = new Redis(redisUrl, {
  keyPrefix: "shario:",
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

export const closeRedisConnection = async (): Promise<void> => {
  if (redisConnection.status === "end") {
    return;
  }

  if (redisConnection.status === "wait") {
    redisConnection.disconnect();
    return;
  }

  await redisConnection.quit();
};

redisConnection.on("error", (error) => {
  logger.error({ err: error }, "Redis connection error.");
});
