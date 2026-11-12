import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startWorkerOperationalTelemetry,
  WORKER_TELEMETRY_INTERVAL_MS,
  WORKER_TELEMETRY_TIMEOUT_MS,
  type WorkerOperationalSample,
} from "@/infrastructure/queues/worker-operational-telemetry.js";

const emptyCounts = () => ({
  waiting: 0,
  active: 0,
  delayed: 0,
  prioritized: 0,
  failed: 0,
  paused: 0,
  "waiting-children": 0,
});

const runtimes: ReturnType<typeof startWorkerOperationalTelemetry>[] = [];
const setup = (role: "communication-email" | "communication-scheduler" | "data-import" = "communication-email") => {
  const getJobCounts = vi.fn().mockResolvedValue(emptyCounts());
  const emit = vi.fn<(sample: WorkerOperationalSample) => void>();
  const runtime = startWorkerOperationalTelemetry({
    role,
    queueName: role === "data-import" ? "data-imports" : "communication-emails",
    queue: { getJobCounts },
    emit,
  });
  runtimes.push(runtime);
  return { getJobCounts, emit, runtime, last: () => emit.mock.calls.at(-1)![0] };
};

describe("worker operational telemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T19:00:00.000Z"));
  });

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop();
    vi.useRealTimers();
  });

  it("emits idle heartbeats immediately and every minute, allowing only count fields", async () => {
    const h = setup();
    h.getJobCounts.mockResolvedValue({
      ...emptyCounts(),
      waiting: 3,
      delayed: 8,
      recipient: "private@example.test",
      payload: { token: "secret" },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.getJobCounts).toHaveBeenCalledWith(
      "waiting", "active", "delayed", "prioritized", "failed", "paused", "waiting-children",
    );
    expect(h.last()).toMatchObject({
      event: "worker_operational_sample",
      schemaVersion: 1,
      role: "communication-email",
      queue: "communication-emails",
      queueObservation: { status: "ok", reason: null, counts: { waiting: 3, delayed: 8 } },
      oldestEligibleJobAgeMs: null,
      eligibleAgeCoverage: "not_collected",
      scheduler: null,
    });
    expect(JSON.stringify(h.last())).not.toMatch(/recipient|payload|secret|private@example/);

    await vi.advanceTimersByTimeAsync(WORKER_TELEMETRY_INTERVAL_MS);
    expect(h.emit).toHaveBeenCalledTimes(2);
    expect(h.last().uptimeMs).toBe(WORKER_TELEMETRY_INTERVAL_MS);
    expect(h.last().activity.completedSinceStart).toBe(0);
  });

  it("reports unavailable counts on failure, preserves last success, and recovers", async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(0);
    const firstSuccess = h.last().lastQueueSampleSucceededAt;
    h.getJobCounts.mockRejectedValueOnce(new Error("redis://credential@private-host"));

    await vi.advanceTimersByTimeAsync(WORKER_TELEMETRY_INTERVAL_MS);
    expect(h.last().queueObservation).toEqual({ status: "unavailable", reason: "probe_failed", counts: null });
    expect(h.last().lastQueueSampleSucceededAt).toBe(firstSuccess);
    expect(JSON.stringify(h.last())).not.toContain("private-host");

    await vi.advanceTimersByTimeAsync(WORKER_TELEMETRY_INTERVAL_MS);
    expect(h.last().queueObservation.status).toBe("ok");
    expect(h.last().lastQueueSampleSucceededAt).not.toBe(firstSuccess);
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a timed-out probe locked until its late %s while heartbeats continue",
    async (settlement) => {
      let resolve!: (counts: ReturnType<typeof emptyCounts>) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<ReturnType<typeof emptyCounts>>((yes, no) => { resolve = yes; reject = no; });
      const h = setup();
      h.getJobCounts.mockReturnValueOnce(pending);

      await vi.advanceTimersByTimeAsync(WORKER_TELEMETRY_TIMEOUT_MS);
      expect(h.last().queueObservation).toEqual({ status: "unavailable", reason: "timeout", counts: null });
      await vi.advanceTimersByTimeAsync(2 * WORKER_TELEMETRY_INTERVAL_MS);
      expect(h.getJobCounts).toHaveBeenCalledTimes(1);
      expect(h.emit).toHaveBeenCalledTimes(3);
      expect(h.last().queueObservation.reason).toBe("probe_in_flight");
      expect(h.last().lastQueueSampleSucceededAt).toBeNull();

      if (settlement === "resolve") resolve(emptyCounts());
      else reject(new Error("secret late failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.emit).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(WORKER_TELEMETRY_INTERVAL_MS);
      expect(h.getJobCounts).toHaveBeenCalledTimes(2);
      expect(h.last().queueObservation.status).toBe("ok");
    },
  );

  it("stops timers without waiting for or emitting a late queue response", async () => {
    let resolve!: (counts: ReturnType<typeof emptyCounts>) => void;
    const h = setup();
    h.getJobCounts.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(0);

    h.runtime.stop();
    h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * WORKER_TELEMETRY_INTERVAL_MS);
    resolve(emptyCounts());
    await vi.advanceTimersByTimeAsync(0);
    await h.runtime.sampleNow();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.getJobCounts).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { ...emptyCounts(), failed: -1 }, { ...emptyCounts(), active: NaN }])(
    "does not turn incomplete or invalid counts into a healthy empty queue",
    async (counts) => {
      const h = setup();
      h.getJobCounts.mockResolvedValue(counts);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.last().queueObservation).toEqual({ status: "unavailable", reason: "invalid_counts", counts: null });
    },
  );

  it("records job completions and failed attempts without changing earlier snapshots", async () => {
    const h = setup("data-import");
    await vi.advanceTimersByTimeAsync(0);
    const before = h.last();
    h.runtime.recordCompleted();
    h.runtime.recordFailedAttempt();
    h.runtime.recordFailedAttempt();
    await h.runtime.sampleNow();

    expect(h.last().activity).toEqual({
      completedSinceStart: 1,
      failedAttemptsSinceStart: 2,
      lastCompletedAt: "2026-10-21T19:00:00.000Z",
      lastFailedAt: "2026-10-21T19:00:00.000Z",
    });
    expect(before.activity.completedSinceStart).toBe(0);
    expect(before.activity.failedAttemptsSinceStart).toBe(0);
  });

  it("tracks scheduler progress, success and failure with only safe result counters", async () => {
    const h = setup("communication-scheduler");
    await vi.advanceTimersByTimeAsync(0);
    h.runtime.recordSchedulerStarted();
    await h.runtime.sampleNow();
    expect(h.last().scheduler?.inFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    h.runtime.recordSchedulerFinished(true, { checked: 2, queued: 1, failed: 0, skipped: -1, tenantId: "private-id", payload: "secret" });
    await h.runtime.sampleNow();
    const success = h.last();
    expect(success.scheduler).toMatchObject({
      inFlight: false,
      lastDurationMs: 25,
      lastSucceededAt: "2026-10-21T19:00:00.025Z",
      lastFailedAt: null,
      lastResult: { checked: 2, queued: 1, failed: 0, skipped: null, suppressed: null },
    });
    expect(JSON.stringify(success)).not.toMatch(/tenantId|payload|private-id|secret/);

    h.runtime.recordSchedulerStarted();
    await vi.advanceTimersByTimeAsync(10);
    h.runtime.recordSchedulerFinished(false);
    await h.runtime.sampleNow();
    expect(h.last().scheduler).toMatchObject({
      inFlight: false,
      lastDurationMs: 10,
      lastSucceededAt: success.scheduler!.lastSucceededAt,
      lastFailedAt: "2026-10-21T19:00:00.035Z",
      lastResult: null,
    });
    expect(success.scheduler?.lastFailedAt).toBeNull();
  });

  it("keeps processing safe if the count collector throws synchronously or logging fails", async () => {
    const h = setup();
    h.getJobCounts.mockImplementationOnce(() => { throw new Error("private config"); });
    h.emit.mockImplementationOnce(() => { throw new Error("sink unavailable"); });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last().queueObservation.reason).toBe("probe_failed");
    await vi.advanceTimersByTimeAsync(WORKER_TELEMETRY_INTERVAL_MS);
    expect(h.last().queueObservation.status).toBe("ok");
    expect(h.getJobCounts).toHaveBeenCalledTimes(2);
  });

  it("emits an unavailable heartbeat when a disabled queue has no metrics reader", async () => {
    const emit = vi.fn();
    const runtime = startWorkerOperationalTelemetry({
      role: "data-import", queueName: "data-imports", queue: {}, emit,
    });
    runtimes.push(runtime);
    await vi.advanceTimersByTimeAsync(0);
    expect(emit.mock.calls[0][0].queueObservation).toEqual({ status: "unavailable", reason: "unsupported", counts: null });
  });
});
