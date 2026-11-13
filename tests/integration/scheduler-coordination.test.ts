import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { RedisSchedulerCoordinator } from "@/infrastructure/scheduling/redis-scheduler-coordinator.js";

// Uses a disposable loopback server, never REDIS_URL or a provider database.
const executable = process.env.TEST_REDIS_SERVER || "redis-server";
const redisAvailable =
  spawnSync(executable, ["--version"], { stdio: "ignore" }).status === 0;
if (
  !redisAvailable &&
  (process.env.CI === "true" || process.env.TEST_REDIS_SERVER)
) {
  throw new Error(
    "Scheduler integration tests require redis-server in CI or at TEST_REDIS_SERVER.",
  );
}

describe.skipIf(!redisAvailable)(
  "scheduler coordination against independent Redis clients",
  () => {
    let server: ChildProcess;
    let first: Redis;
    let second: Redis;
    const log = { error: vi.fn(), warn: vi.fn() };

    beforeAll(async () => {
      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "127.0.0.1", resolve),
      );
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
      server = spawn(
        executable,
        [
          "--bind",
          "127.0.0.1",
          "--port",
          String(port),
          "--save",
          "",
          "--appendonly",
          "no",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Disposable Redis did not start.")),
          5_000,
        );
        server.once("error", reject);
        server.stdout?.on("data", (data) => {
          if (String(data).includes("Ready to accept connections")) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const options = {
        host: "127.0.0.1",
        port,
        enableOfflineQueue: false,
        commandTimeout: 200,
        retryStrategy: () => null,
      };
      first = new Redis(options);
      second = new Redis(options);
      await Promise.all(
        [first, second].map(
          (client) =>
            new Promise<void>((resolve) => client.once("ready", resolve)),
        ),
      );
    });

    afterAll(async () => {
      first?.disconnect();
      second?.disconnect();
      if (server && server.exitCode === null) {
        const exited = new Promise<void>((resolve) =>
          server.once("exit", () => resolve()),
        );
        server.kill("SIGTERM");
        await exited;
      }
    });

    const create = (redis: Redis, onLeaseLost = vi.fn()) =>
      new RedisSchedulerCoordinator(redis, {
        leaseMs: 600,
        renewEveryMs: 100,
        onLeaseLost,
        log: log as never,
      });

    it("atomically selects one owner and retains the slot after a quick completion", async () => {
      const a = create(first);
      const b = create(second);
      const task = vi.fn();
      await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          (index % 2 ? a : b).run("atomicJob", 1_000_000_000_000, task),
        ),
      );
      await b.run("atomicJob", 1_000_000_000_000, task);
      expect(task).toHaveBeenCalledOnce();
      expect(await first.exists("shario:scheduler:{atomicJob}:lease")).toBe(0);
      expect(await first.zcard("shario:scheduler:{atomicJob}:slots")).toBe(1);
      expect(
        await first.pttl("shario:scheduler:{atomicJob}:slots"),
      ).toBeGreaterThan(47 * 60 * 60 * 1000);
    });

    it("renews a long execution across slots, then allows a future slot after release", async () => {
      const a = create(first);
      const b = create(second);
      let finish!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const running = a.run("longJob", 50, () => {
        started();
        return pending;
      });
      await ready;
      await delay(800);
      const task = vi.fn();
      await b.run("longJob", 50, task);
      expect(task).not.toHaveBeenCalled();
      finish();
      await running;
      await b.run("longJob", 50, task);
      expect(task).toHaveBeenCalledOnce();
    });

    it("does not delete or renew a replacement owner's token", async () => {
      const lost = vi.fn();
      const a = create(first, lost);
      let finish!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const running = a.run("replacementJob", 50, () => {
        started();
        return pending;
      });
      await ready;
      await second.set(
        "shario:scheduler:{replacementJob}:lease",
        "replacement",
        "PX",
        5_000,
      );
      await delay(200);
      expect(lost).toHaveBeenCalledOnce();
      finish();
      await running;
      expect(await second.get("shario:scheduler:{replacementJob}:lease")).toBe(
        "replacement",
      );
      expect(
        await second.pttl("shario:scheduler:{replacementJob}:lease"),
      ).toBeGreaterThan(4_000);
    });
  },
);
