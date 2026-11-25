import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkerOperationalTelemetry, type WorkerOperationalSample } from "@/infrastructure/queues/worker-operational-telemetry.js";
import { createWorkerHeartbeatPublisher, evaluateWorkerHeartbeat, projectWorkerHeartbeat, workerHeartbeatKey, WORKER_HEARTBEAT_STALE_MS, WORKER_HEARTBEAT_TTL_SECONDS, WORKER_RECENT_FAILURE_MS } from "@/infrastructure/operations/worker-heartbeats.js";
import { getOperationsConfig, type OperationsWorkerRole } from "@/infrastructure/operations/operations.config.js";

const now = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (offset = 0) => new Date(now + offset).toISOString();
const sample = (role: OperationsWorkerRole = "communication-email"): WorkerOperationalSample => ({
  event: "worker_operational_sample", schemaVersion: 1, role,
  queue: role === "data-import" ? "data-imports" : "communication-emails",
  instanceStartedAt: iso(-60_000), observedAt: iso(), uptimeMs: 60_000,
  queueObservation: { status: "ok", reason: null, counts: { waiting: 0, prioritized: 0, active: 0, delayed: 0, failed: 0, paused: 0, "waiting-children": 0 } },
  lastQueueSampleSucceededAt: iso(), oldestEligibleJobAgeMs: null, eligibleAgeCoverage: "not_collected",
  activity: { completedSinceStart: 0, failedAttemptsSinceStart: 0, lastCompletedAt: null, lastFailedAt: null },
  scheduler: role === "communication-scheduler" ? { inFlight: false, lastStartedAt: null, lastSucceededAt: null, lastFailedAt: null, lastDurationMs: null, lastResult: null } : null,
});
const evaluate = (value = projectWorkerHeartbeat(sample()), role: OperationsWorkerRole = "communication-email", at = now) => evaluateWorkerHeartbeat(role, JSON.stringify(value), at);

describe("worker heartbeat health", () => {
  it("accepts idle workers and ordinary transient waiting work", () => {
    const value = projectWorkerHeartbeat(sample());
    value.counts!.waiting = 2;
    expect(evaluate(value).status).toBe("ok");
    value.counts!.waiting = 101;
    expect(evaluate(value)).toMatchObject({ status: "unhealthy", reason: "queue_backlog", limit: 100 });
  });

  it("reports missing, stale and unavailable queues distinctly", () => {
    expect(evaluateWorkerHeartbeat("data-import", null, now).reason).toBe("missing_heartbeat");
    const value = projectWorkerHeartbeat(sample());
    expect(evaluate(value, "communication-email", now + WORKER_HEARTBEAT_STALE_MS + 1).reason).toBe("stale_heartbeat");
    value.queueStatus = "unavailable";
    value.counts = null;
    expect(evaluate(value)).toMatchObject({ status: "unavailable", reason: "queue_unavailable" });
  });

  it.each([
    (value) => { value.schemaVersion = 2; },
    (value) => { value.role = "unknown"; },
    (value) => { value.observedAt = iso(60_000); },
    (value) => { value.instanceStartedAt = iso(60_000); },
    (value) => { value.activity.lastFailedAt = iso(60_000); },
    (value) => { value.counts.active = -1; },
    (value) => { delete value.counts.waiting; },
    (value) => { value.counts.waiting = Number.MAX_SAFE_INTEGER; value.counts.prioritized = 1; },
    (value) => { delete value.activity; },
    (value) => { value.scheduler = {}; },
  ])("rejects malformed or future snapshots", (mutate) => {
    const value = projectWorkerHeartbeat(sample());
    mutate(value);
    expect(evaluate(value)).toMatchObject({ status: "unavailable", reason: "invalid_heartbeat" });
  });

  it("does not permanently alarm on retained failed jobs, but reports recent retryable attempts", () => {
    const value = projectWorkerHeartbeat(sample());
    value.counts!.failed = 40;
    value.activity.lastFailedAt = iso(-WORKER_RECENT_FAILURE_MS - 1);
    expect(evaluate(value)).toMatchObject({ status: "ok", failed: 40 });
    value.activity.lastFailedAt = iso(-30_000);
    expect(evaluate(value).reason).toBe("recent_failed_attempt");
    value.activity.lastCompletedAt = iso(-1_000);
    expect(evaluate(value).reason).toBe("recent_failed_attempt");
  });

  it("uses sustained observed active time, allowing new jobs after a long idle period", () => {
    const value = projectWorkerHeartbeat(sample());
    value.instanceStartedAt = iso(-24 * 60 * 60_000);
    value.counts!.active = 1;
    value.workObservedSince = iso();
    expect(evaluate(value).status).toBe("ok");
    value.workObservedSince = iso(-16 * 60_000);
    expect(evaluate(value).reason).toBe("work_without_recent_completion");
    value.activity.lastCompletedAt = iso(-60_000);
    expect(evaluate(value).status).toBe("ok");
  });

  it("detects scheduler failure, hung runs and overdue success with cadence tolerance", () => {
    const value = projectWorkerHeartbeat(sample("communication-scheduler"));
    expect(evaluate(value, "communication-scheduler").status).toBe("ok");
    value.scheduler!.lastFailedAt = iso(-10_000);
    expect(evaluate(value, "communication-scheduler").reason).toBe("scheduler_failed");
    value.scheduler!.lastSucceededAt = iso(-1_000);
    expect(evaluate(value, "communication-scheduler").status).toBe("ok");
    value.scheduler!.inFlight = true;
    value.scheduler!.lastStartedAt = iso(-11 * 60_000);
    expect(evaluate(value, "communication-scheduler").reason).toBe("scheduler_run_overdue");
    value.scheduler!.inFlight = false;
    value.scheduler!.lastFailedAt = null;
    value.scheduler!.lastSucceededAt = iso(-4 * 60_000);
    expect(evaluate(value, "communication-scheduler").reason).toBe("scheduler_success_overdue");
    expect(evaluateWorkerHeartbeat("communication-scheduler", JSON.stringify(value), now, 5 * 60_000).status).toBe("ok");
  });
});

describe("bounded worker heartbeat publication", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  const configured = () => getOperationsConfig({ OPS_MONITOR_TOKEN: "test-token-that-has-at-least-32-characters", OPS_MONITOR_NAMESPACE: "staging" });

  it("retains terminal import failures until the next five-minute poll after heartbeat publication", async () => {
    // Minute samples at :01 and workflow polls at :00 can straddle all three
    // import attempts, which use ten- and twenty-second retry delays.
    vi.setSystemTime(now + 1_000);
    const set = vi.fn().mockResolvedValue("OK");
    const publish = createWorkerHeartbeatPublisher(async () => ({ status: "ready", set }), configured);
    const counts = { waiting: 0, prioritized: 0, active: 0, delayed: 0, failed: 0, paused: 0, "waiting-children": 0 };
    const telemetry = startWorkerOperationalTelemetry({
      role: "data-import", queueName: "data-imports",
      queue: { getJobCounts: async () => ({ ...counts }) },
      emit: publish,
    });
    const advanceTo = (offsetMs: number) => vi.advanceTimersByTimeAsync(now + offsetMs - Date.now());
    const pollAt = async (minute: number) => {
      await advanceTo(minute * 60_000);
      return evaluateWorkerHeartbeat("data-import", set.mock.calls.at(-1)![1], Date.now());
    };
    try {
      for (const second of [362, 372, 392]) {
        await advanceTo(second * 1_000);
        telemetry.recordFailedAttempt();
      }
      counts.failed = 1;
      // The 12:07 poll still sees the 12:06:01 pre-failure heartbeat.
      expect(await pollAt(7)).toMatchObject({ status: "ok", failed: 0, observedAt: iso(361_000) });
      // The next normal poll sees a failure older than five minutes. A delayed
      // poll at 12:17 also retains it, without alarming on retained jobs forever.
      for (const minute of [12, 17]) {
        expect(await pollAt(minute)).toMatchObject({ status: "unhealthy", reason: "recent_failed_attempt", failed: 1 });
      }
      expect(await pollAt(22)).toMatchObject({ status: "ok", reason: "healthy", failed: 1 });
    } finally {
      telemetry.stop();
    }
  });

  const progressFixture = (role: OperationsWorkerRole = "communication-email") => {
    const set = vi.fn().mockResolvedValue("OK");
    const publish = createWorkerHeartbeatPublisher(async () => ({ status: "ready", set }), configured);
    const value = sample(role);
    value.instanceStartedAt = iso(-24 * 60 * 60_000);
    if (value.queueObservation.status !== "ok") throw new Error("Expected healthy fixture counts");
    const counts = value.queueObservation.counts;
    const observe = async (minute: number, offsetMs = 0) => {
      const elapsedMs = minute * 60_000 + offsetMs;
      value.observedAt = iso(elapsedMs);
      publish(value);
      await vi.advanceTimersByTimeAsync(0);
      const raw = set.mock.calls.at(-1)![1];
      return { snapshot: JSON.parse(raw), check: evaluateWorkerHeartbeat(role, raw, now + elapsedMs) };
    };
    return { value, counts, observe };
  };

  it.each([
    { role: "communication-email", state: "waiting", count: 1, budget: 15 },
    { role: "communication-email", state: "prioritized", count: 100, budget: 15 },
    { role: "data-import", state: "waiting", count: 1, budget: 30 },
    { role: "data-import", state: "prioritized", count: 100, budget: 30 },
  ] as const)("detects stalled $role with $count $state jobs and fresh heartbeats but no active jobs", async ({ role, state, count, budget }) => {
    const h = progressFixture(role);
    h.counts[state] = count;
    for (let minute = 0; minute <= budget; minute++) {
      // Recently queued work is healthy even after the process was idle a day.
      expect((await h.observe(minute)).check.status).toBe("ok");
    }
    const stalled = await h.observe(budget + 1);
    expect(stalled.snapshot.workObservedSince).toBe(iso());
    expect(stalled.check).toMatchObject({ status: "unhealthy", reason: "work_without_recent_completion", waiting: count, active: 0, ageMs: 0, thresholdMs: budget * 60_000 });
  });

  it("preserves the work period across waiting, active and prioritized transitions", async () => {
    const h = progressFixture();
    const states = ["waiting", "active", "prioritized", "waiting"] as const;
    for (let minute = 0; minute <= 16; minute++) {
      h.counts.waiting = h.counts.active = h.counts.prioritized = 0;
      h.counts[states[minute % states.length]] = 1;
      const result = await h.observe(minute);
      expect(result.snapshot.workObservedSince).toBe(iso());
      expect(result.check.status).toBe(minute <= 15 ? "ok" : "unhealthy");
    }
  });

  it("keeps delayed-only work healthy and resets the period before newly runnable jobs", async () => {
    const h = progressFixture();
    h.counts.waiting = 1;
    await h.observe(0);
    h.counts.waiting = 0;
    h.counts.delayed = 1_000;
    for (let minute = 1; minute <= 32; minute++) {
      const result = await h.observe(minute);
      expect(result.snapshot.workObservedSince).toBeNull();
      expect(result.check.status).toBe("ok");
    }
    h.counts.waiting = 1;
    const resumed = await h.observe(33);
    expect(resumed.snapshot.workObservedSince).toBe(iso(33 * 60_000));
    expect(resumed.check.status).toBe("ok");
    h.counts.waiting = h.counts.delayed = 0;
    expect((await h.observe(34)).snapshot.workObservedSince).toBeNull();
  });

  it("recovers after a completion and grants a fresh progress budget while work remains", async () => {
    const h = progressFixture();
    h.counts.waiting = 1;
    for (let minute = 0; minute <= 15; minute++) await h.observe(minute);
    expect((await h.observe(16)).check.reason).toBe("work_without_recent_completion");
    h.value.activity.lastCompletedAt = iso(17 * 60_000);
    h.value.activity.completedSinceStart = 1;
    for (let minute = 17; minute <= 32; minute++) {
      const result = await h.observe(minute);
      expect(result.snapshot.workObservedSince).toBe(iso());
      expect(result.check.status).toBe("ok");
    }
    expect((await h.observe(33)).check.reason).toBe("work_without_recent_completion");
  });

  it.each([0, 1_000])("does not let brief unavailable counts plus %ims probe jitter hide a stall from five-minute polling", async (jitterMs) => {
    const h = progressFixture();
    h.counts.waiting = 1;
    const knownCounts = h.value.queueObservation;
    const polledStatuses: string[] = [];
    for (let minute = 0; minute <= 30; minute++) {
      const unavailable = minute > 0 && minute % 7 === 0;
      h.value.queueObservation = unavailable
        ? { status: "unavailable", reason: "timeout", counts: null }
        : knownCounts;
      const result = await h.observe(minute, minute === 8 ? jitterMs : 0);
      expect(result.snapshot.workObservedSince).toBe(iso());
      expect(result.check.status).toBe(unavailable ? "unavailable" : minute <= 15 ? "ok" : "unhealthy");
      if (minute % 5 === 0) polledStatuses.push(result.check.status);
      if (!unavailable && minute > 15) expect(result.check.reason).toBe("work_without_recent_completion");
    }
    expect(polledStatuses).toEqual(["ok", "ok", "ok", "ok", "unhealthy", "unhealthy", "unhealthy"]);
  });

  it("resets continuity after successful queue counts are unavailable beyond the 125-second boundary", async () => {
    const h = progressFixture();
    h.counts.waiting = 1;
    const knownCounts = h.value.queueObservation;
    await h.observe(0);
    h.value.queueObservation = { status: "unavailable", reason: "timeout", counts: null };
    expect((await h.observe(1)).snapshot.workObservedSince).toBe(iso());
    expect((await h.observe(2)).snapshot.workObservedSince).toBe(iso());
    expect((await h.observe(3)).snapshot.workObservedSince).toBeNull();
    h.value.queueObservation = knownCounts;
    const resumed = await h.observe(4);
    expect(resumed.snapshot.workObservedSince).toBe(iso(4 * 60_000));
    expect(resumed.check.status).toBe("ok");
  });

  it.each([{ offsetMs: 5_000, preserved: true }, { offsetMs: 5_001, preserved: false }])("defines the successful-count observation boundary at 125 seconds ($offsetMs ms offset)", async ({ offsetMs, preserved }) => {
    const h = progressFixture();
    h.counts.waiting = 1;
    const knownCounts = h.value.queueObservation;
    await h.observe(0);
    h.value.queueObservation = { status: "unavailable", reason: "timeout", counts: null };
    await h.observe(1);
    h.value.queueObservation = knownCounts;
    const resumed = await h.observe(2, offsetMs);
    expect(resumed.snapshot.workObservedSince).toBe(preserved ? iso() : iso(120_000 + offsetMs));
    expect(resumed.check.status).toBe("ok");
  });

  it("does not open Redis when disabled or misconfigured", async () => {
    const redis = vi.fn();
    createWorkerHeartbeatPublisher(redis, () => getOperationsConfig({}))(sample());
    createWorkerHeartbeatPublisher(redis, () => ({ ...configured(), valid: false }))(sample());
    await vi.advanceTimersByTimeAsync(0);
    expect(redis).not.toHaveBeenCalled();
  });

  it("uses one bounded key per environment/role and excludes private or unknown fields", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    const publish = createWorkerHeartbeatPublisher(async () => ({ status: "ready", set }), configured);
    const value = Object.assign(sample(), { recipient: "private@example.test", error: "provider secret", payload: { token: "secret" } });
    publish(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toHaveBeenCalledWith(workerHeartbeatKey("staging", "communication-email"), expect.any(String), "EX", WORKER_HEARTBEAT_TTL_SECONDS);
    expect(workerHeartbeatKey("production", "communication-email")).not.toBe(workerHeartbeatKey("staging", "communication-email"));
    expect(set.mock.calls[0][1]).not.toMatch(/private|provider secret|recipient|payload|token/);
    expect(evaluateWorkerHeartbeat("communication-email", set.mock.calls[0][1], now).status).toBe("ok");
  });

  it("never buffers disconnected writes or accumulates writes behind a hung Redis command", async () => {
    let finish!: () => void;
    const set = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const redis = { status: "reconnecting", set };
    const connect = vi.fn(async () => redis);
    const publish = createWorkerHeartbeatPublisher(connect, configured);
    publish(sample());
    await vi.advanceTimersByTimeAsync(0);
    expect(set).not.toHaveBeenCalled();
    redis.status = "ready";
    publish(sample());
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) { publish(sample()); await vi.advanceTimersByTimeAsync(60_000); }
    expect(set).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    set.mockResolvedValue("OK");
    publish(sample());
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("contains Redis write failure and recovers on the next sample", async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error("redis://private:secret")).mockResolvedValue("OK");
    const publish = createWorkerHeartbeatPublisher(async () => ({ status: "ready", set }), configured);
    expect(() => publish(sample())).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    publish(sample());
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "waiting"] as const)("resets the continuous-work period for %s jobs after an observation gap", async (state) => {
    const set = vi.fn().mockResolvedValue("OK");
    const publish = createWorkerHeartbeatPublisher(async () => ({ status: "ready", set }), configured);
    const value = sample();
    if (value.queueObservation.status === "ok") value.queueObservation.counts[state] = 1;
    publish(value);
    await vi.advanceTimersByTimeAsync(0);
    value.observedAt = iso(20 * 60_000);
    publish(value);
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = JSON.parse(set.mock.calls[1][1]);
    expect(snapshot.workObservedSince).toBe(value.observedAt);
    expect(evaluateWorkerHeartbeat("communication-email", JSON.stringify(snapshot), now + 20 * 60_000).status).toBe("ok");
  });
});
