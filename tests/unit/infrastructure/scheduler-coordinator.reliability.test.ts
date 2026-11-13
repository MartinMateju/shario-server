import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";

import { CronSupervisor } from "@/infrastructure/scheduling/cron-supervisor.js";
import { RedisSchedulerCoordinator } from "@/infrastructure/scheduling/redis-scheduler-coordinator.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const createStore = () => {
  const leases = new Map<string, string>();
  const claimed = new Set<string>();
  const evalCommand = vi.fn(
    async (script: string, count: number, ...args: Array<string | number>) => {
      const key = String(args[0]);
      const token = String(args[count]);
      if (script.includes("redis.call('TIME')")) {
        const slot = `${args[1]}:${Math.floor(Date.now() / Number(args[count + 2]))}`;
        if (leases.has(key) || claimed.has(slot)) return 0;
        leases.set(key, token);
        claimed.add(slot);
        return 1;
      }
      if (leases.get(key) !== token) return 0;
      if (script.includes("redis.call('DEL'")) leases.delete(key);
      return 1;
    },
  );
  return { leases, evalCommand, redis: { eval: evalCommand } as never };
};
const makeCoordinator = (store: ReturnType<typeof createStore>) => {
  const onLeaseLost = vi.fn();
  const log = { warn: vi.fn(), error: vi.fn() };
  return {
    coordinator: new RedisSchedulerCoordinator(store.redis, {
      leaseMs: 900,
      renewEveryMs: 150,
      onLeaseLost,
      log: log as never,
    }),
    onLeaseLost,
    log,
  };
};

afterEach(() => vi.useRealTimers());

describe("distributed scheduler fail-closed lifecycle", () => {
  it("prevents simultaneous and sequential duplicates across two supervisors in the same slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);
    const store = createStore();
    const first = makeCoordinator(store);
    const second = makeCoordinator(store);
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const a = new CronSupervisor(
      vi.fn() as never,
      log as never,
      first.coordinator,
    );
    const b = new CronSupervisor(
      vi.fn() as never,
      log as never,
      second.coordinator,
    );
    const pending = deferred();
    const started = deferred();
    const task = vi.fn(() => {
      started.resolve();
      return pending.promise;
    });
    const running = a.run("sharedJob", task);
    await started.promise;
    await b.run("sharedJob", task);
    expect(task).toHaveBeenCalledOnce();
    pending.resolve();
    await running;
    await b.run("sharedJob", task);
    expect(task).toHaveBeenCalledOnce();
    vi.setSystemTime(180_000);
    await b.run("sharedJob", task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("keeps renewing while stopped work drains, then releases only its own lease", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const { coordinator } = makeCoordinator(store);
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const supervisor = new CronSupervisor(
      vi.fn() as never,
      log as never,
      coordinator,
    );
    const pending = deferred();
    const started = deferred();
    const running = supervisor.run("drainingJob", () => {
      started.resolve();
      return pending.promise;
    });
    await started.promise;
    supervisor.stop();
    await vi.advanceTimersByTimeAsync(450);
    expect(store.leases.size).toBe(1);
    expect(
      store.evalCommand.mock.calls.filter(
        ([script]) => !script.includes("TIME"),
      ),
    ).toHaveLength(3);
    let drained = false;
    const drain = supervisor.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve();
    await Promise.all([running, drain]);
    expect(store.leases.size).toBe(0);
    const calls = store.evalCommand.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.evalCommand).toHaveBeenCalledTimes(calls);
  });

  it("skips work on uncertain acquisition and never logs credential-bearing errors", async () => {
    const store = createStore();
    store.evalCommand.mockRejectedValueOnce(
      new Error("redis://user:private@host"),
    );
    const { coordinator, onLeaseLost, log } = makeCoordinator(store);
    const task = vi.fn();
    await coordinator.run("unavailableJob", 60_000, task);
    expect(task).not.toHaveBeenCalled();
    expect(onLeaseLost).not.toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("private");
  });

  it.each(["error", "lost"])(
    "fails closed on %s renewal and leaves uncertain ownership to expire",
    async (mode) => {
      vi.useFakeTimers();
      const store = createStore();
      const { coordinator, onLeaseLost } = makeCoordinator(store);
      const pending = deferred();
      const started = deferred();
      const running = coordinator.run("renewalJob", 60_000, () => {
        started.resolve();
        return pending.promise;
      });
      await started.promise;
      if (mode === "error")
        store.evalCommand.mockRejectedValueOnce(new Error("offline"));
      else store.evalCommand.mockResolvedValueOnce(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(onLeaseLost).toHaveBeenCalledOnce();
      const later = vi.fn();
      await coordinator.run("otherJob", 60_000, later);
      expect(later).not.toHaveBeenCalled();
      pending.resolve();
      await running;
      expect(store.leases.size).toBe(1);
      expect(
        store.evalCommand.mock.calls.some(([script]) =>
          script.includes("redis.call('DEL'"),
        ),
      ).toBe(false);
    },
  );

  it("does not release another owner's lease when a finished task's token no longer matches", async () => {
    const store = createStore();
    const { coordinator } = makeCoordinator(store);
    await coordinator.run("tokenJob", 60_000, () => {
      store.leases.set("shario:scheduler:{tokenJob}:lease", "different-owner");
    });
    expect(store.leases.get("shario:scheduler:{tokenJob}:lease")).toBe(
      "different-owner",
    );
  });

  it("does not retry a failed task in the already claimed slot", async () => {
    const store = createStore();
    const { coordinator } = makeCoordinator(store);
    await expect(
      coordinator.run("failedJob", 60_000, () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    const retry = vi.fn();
    await coordinator.run("failedJob", 60_000, retry);
    expect(retry).not.toHaveBeenCalled();
  });

  it("never starts work when acquisition returns after its safe lease window", async () => {
    const store = createStore();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValue(800);
    const { coordinator, onLeaseLost } = makeCoordinator(store);
    const task = vi.fn();
    await coordinator.run("delayedJob", 60_000, task);
    expect(task).not.toHaveBeenCalled();
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(store.leases.size).toBe(1);
  });

  it("waits for an in-flight renewal before deciding whether a finished run can release", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const { coordinator, onLeaseLost } = makeCoordinator(store);
    const pending = deferred();
    const started = deferred();
    const running = coordinator.run("uncertainJob", 60_000, () => {
      started.resolve();
      return pending.promise;
    });
    await started.promise;
    let rejectRenewal!: (error: Error) => void;
    store.evalCommand.mockImplementationOnce(
      () =>
        new Promise<0 | 1>((_resolve, reject) => {
          rejectRenewal = reject;
        }),
    );
    await vi.advanceTimersByTimeAsync(150);
    pending.resolve();
    await Promise.resolve();
    expect(store.leases.size).toBe(1);
    rejectRenewal(new Error("unconfirmed renewal"));
    await running;
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(store.leases.size).toBe(1);
  });

  it("does not begin work if shutdown happens while acquisition is pending", async () => {
    const acquired = deferred();
    const store = createStore();
    const original = store.evalCommand.getMockImplementation()!;
    store.evalCommand.mockImplementationOnce(async (...args) => {
      await acquired.promise;
      return original(...args);
    });
    const { coordinator } = makeCoordinator(store);
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const supervisor = new CronSupervisor(
      vi.fn() as never,
      log as never,
      coordinator,
    );
    const task = vi.fn();
    const running = supervisor.run("shutdownJob", task);
    await Promise.resolve();
    supervisor.stop();
    acquired.resolve();
    await Promise.all([running, supervisor.drain()]);
    expect(task).not.toHaveBeenCalled();
    expect(store.leases.size).toBe(0);
  });
});
