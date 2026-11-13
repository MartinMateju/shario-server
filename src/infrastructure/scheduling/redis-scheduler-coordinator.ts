import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Redis } from "ioredis";

import { logger } from "@/config/logger.js";

export interface SchedulerCoordinator {
  run(
    name: string,
    intervalMs: number,
    task: () => unknown | Promise<unknown>,
  ): Promise<void>;
}

type SchedulerRedis = Pick<Redis, "eval">;
type SchedulerLogger = Pick<typeof logger, "error" | "warn">;

// Claim the execution and its time slot atomically. The slot survives release:
// a second deployment cannot repeat a quick job in the same minute. Redis TIME
// avoids using different process clocks to determine the current interval.
const ACQUIRE = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local slot = tostring(math.floor(now / tonumber(ARGV[3])))
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('ZSCORE', KEYS[2], slot) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], now, slot)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 1
`;
const RENEW = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;
const RELEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export class RedisSchedulerCoordinator implements SchedulerCoordinator {
  private healthy = true;

  constructor(
    private readonly redis: SchedulerRedis,
    private readonly options: {
      leaseMs?: number;
      renewEveryMs?: number;
      onLeaseLost: () => void;
      log?: SchedulerLogger;
    },
  ) {}

  async run(
    name: string,
    intervalMs: number,
    task: () => unknown | Promise<unknown>,
  ): Promise<void> {
    if (!this.healthy) return;
    if (
      !/^[a-zA-Z0-9_-]+$/.test(name) ||
      !Number.isFinite(intervalMs) ||
      intervalMs < 1
    ) {
      throw new Error("Invalid scheduler job name or interval.");
    }
    const leaseMs = this.options.leaseMs ?? 90_000;
    const renewEveryMs = this.options.renewEveryMs ?? 15_000;
    if (renewEveryMs <= 0 || leaseMs < renewEveryMs * 3) {
      throw new Error(
        "Scheduler lease must allow at least three renewal intervals.",
      );
    }
    const log = this.options.log ?? logger;
    const token = randomUUID();
    // Shared hash tag keeps both keys together if Redis Cluster is used later.
    const leaseKey = `shario:scheduler:{${name}}:lease`;
    const slotsKey = `shario:scheduler:{${name}}:slots`;
    let leaseStartedAt = performance.now();
    try {
      const acquired = await this.redis.eval(
        ACQUIRE,
        2,
        leaseKey,
        slotsKey,
        token,
        leaseMs,
        intervalMs,
        48 * 60 * 60 * 1000,
      );
      if (Number(acquired) !== 1) return;
    } catch {
      // Do not log connection errors: Redis URLs can contain credentials.
      log.warn(
        { cron: name },
        "Scheduled work skipped: coordination is unavailable.",
      );
      return;
    }

    let lost = false;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let renewal: Promise<void> | undefined;
    const loseLease = () => {
      if (lost) return;
      lost = true;
      this.healthy = false;
      log.error(
        { cron: name },
        "Scheduler ownership could not be confirmed; terminating to stop unowned work.",
      );
      this.options.onLeaseLost();
    };
    const renew = async () => {
      // Never resume an expired lease after a long event-loop pause.
      if (performance.now() - leaseStartedAt >= leaseMs - renewEveryMs) {
        loseLease();
        return;
      }
      const startedAt = performance.now();
      try {
        const renewed = await this.redis.eval(
          RENEW,
          1,
          leaseKey,
          token,
          leaseMs,
        );
        if (
          Number(renewed) !== 1 ||
          performance.now() - startedAt >= leaseMs - renewEveryMs
        ) {
          loseLease();
          return;
        }
        leaseStartedAt = startedAt;
      } catch {
        loseLease();
        return;
      }
      if (!finished && !lost) scheduleRenewal();
    };
    const scheduleRenewal = () => {
      timer = setTimeout(() => {
        renewal = renew();
      }, renewEveryMs);
      timer.unref?.();
    };

    try {
      if (
        !this.healthy ||
        performance.now() - leaseStartedAt >= leaseMs - renewEveryMs
      ) {
        loseLease();
        return;
      }
      scheduleRenewal();
      await task();
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      await renewal;
      // A failed renewal is ambiguous. Keep the lease until expiry rather than
      // handing ownership to another process while this one may still work.
      if (!lost) {
        try {
          if (
            Number(await this.redis.eval(RELEASE, 1, leaseKey, token)) !== 1
          ) {
            loseLease();
          }
        } catch {
          log.warn(
            { cron: name },
            "Finished scheduler lease will expire without explicit release.",
          );
        }
      }
    }
  }
}

export const createRedisSchedulerCoordinator = () => {
  if (!process.env.REDIS_URL)
    throw new Error("REDIS_URL is required for scheduler coordination.");
  const redis = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    retryStrategy: () => 1_000,
  });
  redis.on("error", () =>
    logger.warn("Scheduler Redis connection unavailable."),
  );
  return {
    coordinator: new RedisSchedulerCoordinator(redis, {
      // Existing tasks cannot be forcibly cancelled. Exiting promptly prevents
      // continuing work without ownership; Render restarts the process.
      onLeaseLost: () => process.exit(1),
    }),
    close: () => redis.disconnect(),
  };
};
