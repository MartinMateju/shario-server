import { describe, expect, it, vi } from "vitest";
import { CronHealthRegistry, CRITICAL_CRON_BUDGETS } from "@/infrastructure/operations/cron-health.js";
import { CronSupervisor } from "@/infrastructure/scheduling/cron-supervisor.js";

describe("critical cron monitoring", () => {
  it("fails missing registrations and applies actual cadence startup budgets", () => {
    const health = new CronHealthRegistry();
    expect(health.checks(0).every((check) => check.reason === "not_registered" && check.status === "unhealthy")).toBe(true);
    for (const name of Object.keys(CRITICAL_CRON_BUDGETS)) health.register(name, 0);
    expect(health.checks(4 * 60_000).every((check) => check.status === "ok")).toBe(true);
    expect(health.checks(24 * 60_000).find((check) => check.id === "cron.reportPaidUnfulfilledOrders")?.status).toBe("ok");
    expect(health.checks(74 * 60_000).find((check) => check.id === "cron.sendUpcomingBookingReminders")?.status).toBe("ok");
    expect(health.checks(76 * 60_000).find((check) => check.id === "cron.sendUpcomingBookingReminders")?.reason).toBe("success_overdue");
  });

  it("reports failure and recovery even when outcomes have the same millisecond", () => {
    const health = new CronHealthRegistry();
    const name = "sendOutAccessCodes";
    const check = () => health.checks(100).find((entry) => entry.id === `cron.${name}`)!;
    health.register(name, 0);
    health.finished(name, true, 100);
    health.finished(name, false, 100);
    expect(check().reason).toBe("last_run_failed");
    health.finished(name, true, 100);
    expect(check().reason).toBe("healthy");
    health.stop(name);
    expect(check().reason).toBe("stopped");
  });

  it("observes a hung supervised task without duplicating or canceling its work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const health = new CronHealthRegistry();
    let tick!: () => void;
    const schedule = vi.fn((_expression, callback) => { tick = callback; return { stop: vi.fn() } as never; });
    const supervisor = new CronSupervisor(schedule, { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never, undefined, health);
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    supervisor.schedule("sendOutAccessCodes", "* * * * *", task);
    tick();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    tick();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    expect(health.checks().find((check) => check.id === "cron.sendOutAccessCodes")?.reason).toBe("run_overdue");
    finish();
    await supervisor.drain();
    expect(health.checks().find((check) => check.id === "cron.sendOutAccessCodes")?.status).toBe("ok");
    supervisor.stop();
  });
});
