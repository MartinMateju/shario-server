import { describe, expect, it, vi } from "vitest";

import { CronSupervisor } from "@/infrastructure/scheduling/cron-supervisor.js";

describe("cron supervisor", () => {
  it("prevents overlap, tracks the active run, and drains it after stopping", async () => {
    const callbacks: Array<() => void> = [];
    const stop = vi.fn();
    const schedule = vi.fn((_expression: string, callback: () => void) => {
      callbacks.push(callback);
      return { stop } as never;
    });
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    let finish: () => void = () => undefined;
    const activeTask = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task = vi.fn(() => activeTask);
    const supervisor = new CronSupervisor(schedule, log as never);

    supervisor.schedule("long-running", "* * * * *", task);
    callbacks[0]();
    callbacks[0]();
    await Promise.resolve();

    expect(task).toHaveBeenCalledOnce();
    expect(supervisor.activeRunCount).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      { cron: "long-running" },
      expect.stringContaining("previous run"),
    );

    supervisor.stop();
    expect(stop).toHaveBeenCalledOnce();

    let drained = false;
    const drain = supervisor.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finish();
    await drain;
    expect(drained).toBe(true);
    expect(supervisor.activeRunCount).toBe(0);

    callbacks[0]();
    await Promise.resolve();
    expect(task).toHaveBeenCalledOnce();
  });

  it("contains task failures so scheduled callbacks cannot create unhandled rejections", async () => {
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const supervisor = new CronSupervisor(vi.fn() as never, log as never);
    const failure = new Error("cron failed");

    await expect(
      supervisor.run("failing-job", async () => {
        throw failure;
      }),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      { err: failure, cron: "failing-job" },
      "Cron job failed.",
    );
  });
});
