import type { WorkerOperationalSample } from "@/infrastructure/queues/worker-operational-telemetry.js";
import { getOperationsConfig, isOperationsEnabled, type OperationsCheck, type OperationsConfig, type OperationsWorkerRole } from "./operations.config.js";

export const WORKER_HEARTBEAT_TTL_SECONDS = 86_400;
export const WORKER_HEARTBEAT_STALE_MS = 3 * 60_000;
export const WORKER_QUEUE_BACKLOG_LIMIT = 100;
// Retain failures across the five-minute poll cadence, one-minute heartbeat
// publication delay, and scheduling jitter. This remains a bounded signal.
export const WORKER_RECENT_FAILURE_MS = 15 * 60_000;
// Two one-minute sample intervals, two bounded two-second probes, and one
// second of scheduling tolerance. Longer unknown periods reset continuity.
export const WORKER_OBSERVATION_GAP_MS = 125_000;
const MAX_SNAPSHOT_BYTES = 8_192;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

type Heartbeat = {
  schemaVersion: 1;
  role: OperationsWorkerRole;
  observedAt: string;
  instanceStartedAt: string;
  queueStatus: "ok" | "unavailable";
  counts: { waiting: number; prioritized: number; active: number; delayed: number; failed: number; paused: number } | null;
  activity: { lastCompletedAt: string | null; lastFailedAt: string | null };
  workObservedSince: string | null;
  scheduler: { inFlight: boolean; lastStartedAt: string | null; lastSucceededAt: string | null; lastFailedAt: string | null } | null;
};

export const workerHeartbeatKey = (namespace: string, role: OperationsWorkerRole): string =>
  `shario:operations:v1:${namespace}:worker:${role}`;

// Explicit projection prevents future worker/job fields from exposing customer
// data or provider errors through Redis or this endpoint.
export const projectWorkerHeartbeat = (sample: WorkerOperationalSample, workObservedSince: string | null = null): Heartbeat => ({
  schemaVersion: 1,
  role: sample.role,
  observedAt: sample.observedAt,
  instanceStartedAt: sample.instanceStartedAt,
  queueStatus: sample.queueObservation.status,
  counts: sample.queueObservation.status === "ok" ? {
    waiting: sample.queueObservation.counts.waiting,
    prioritized: sample.queueObservation.counts.prioritized,
    active: sample.queueObservation.counts.active,
    delayed: sample.queueObservation.counts.delayed,
    failed: sample.queueObservation.counts.failed,
    paused: sample.queueObservation.counts.paused,
  } : null,
  activity: {
    lastCompletedAt: sample.activity.lastCompletedAt,
    lastFailedAt: sample.activity.lastFailedAt,
  },
  workObservedSince,
  scheduler: sample.scheduler ? {
    inFlight: sample.scheduler.inFlight,
    lastStartedAt: sample.scheduler.lastStartedAt,
    lastSucceededAt: sample.scheduler.lastSucceededAt,
    lastFailedAt: sample.scheduler.lastFailedAt,
  } : null,
});

export const getOperationsRedis = async () => {
  const { redisConnection } = await import("@/infrastructure/redis/redis.js");
  if (redisConnection.status === "wait") await redisConnection.connect();
  return redisConnection;
};

export const createWorkerHeartbeatPublisher = (
  getRedis: () => Promise<{ status: string; set: (key: string, value: string, mode: "EX", ttl: number) => Promise<unknown> }> = getOperationsRedis,
  config = getOperationsConfig,
) => {
  let pending: Promise<unknown> | null = null;
  let workObservedSince: string | null = null;
  let lastCountsObservedAt: number | null = null;
  return (sample: WorkerOperationalSample): void => {
    const settings = config();
    if (!isOperationsEnabled(settings) || !settings.valid) return;
    // A long gap in successful counts is not proof runnable work remained.
    // Brief unavailable samples are not evidence of an empty queue, and must
    // not repeatedly restart the budget while a consumer remains stalled.
    if (lastCountsObservedAt !== null && Date.parse(sample.observedAt) - lastCountsObservedAt > WORKER_OBSERVATION_GAP_MS) workObservedSince = null;
    const counts = sample.queueObservation.status === "ok" ? sample.queueObservation.counts : null;
    // A consumer can stall before claiming its first job. Waiting/prioritized
    // work needs the same progress budget as active work; delayed-only jobs do
    // not establish a runnable-work period.
    if (counts) {
      lastCountsObservedAt = Date.parse(sample.observedAt);
      workObservedSince = counts.waiting > 0 || counts.prioritized > 0 || counts.active > 0
        ? workObservedSince ?? sample.observedAt : null;
    }
    if (pending) return;
    const snapshot = projectWorkerHeartbeat(sample, workObservedSince);
    const operation = Promise.resolve().then(async () => {
      const redis = await getRedis();
      // Never queue telemetry behind a disconnected cache connection.
      if (redis.status !== "ready") return;
      await redis.set(workerHeartbeatKey(settings.namespace, sample.role), JSON.stringify(snapshot), "EX", WORKER_HEARTBEAT_TTL_SECONDS);
    }).catch(() => undefined);
    pending = operation;
    // Retain the lock until the real operation settles, not just a timeout.
    // Monitoring must never enqueue unbounded writes during a Redis outage.
    void operation.finally(() => { if (pending === operation) pending = null; });
  };
};

export const publishWorkerHeartbeat = createWorkerHeartbeatPublisher();

export const evaluateWorkerHeartbeat = (
  role: OperationsWorkerRole,
  raw: string | null,
  now = Date.now(),
  schedulerIntervalMs = 60_000,
): OperationsCheck => {
  const id = `worker.${role}`;
  if (raw === null) return { id, status: "unhealthy", reason: "missing_heartbeat" };
  let sample: Heartbeat;
  try {
    const validTime = (value: unknown) => timestamp(value) && Date.parse(value) <= now + 30_000;
    if (raw.length > MAX_SNAPSHOT_BYTES) throw new Error();
    sample = JSON.parse(raw);
    if (sample.schemaVersion !== 1 || sample.role !== role || !validTime(sample.observedAt) ||
      !validTime(sample.instanceStartedAt) || Date.parse(sample.instanceStartedAt) > Date.parse(sample.observedAt) ||
      !["ok", "unavailable"].includes(sample.queueStatus)) throw new Error();
    if (sample.queueStatus === "ok" && (!sample.counts ||
      !["waiting", "prioritized", "active", "delayed", "failed", "paused"].every((key) => integer(sample.counts?.[key])) ||
      !integer(sample.counts.waiting + sample.counts.prioritized))) throw new Error();
    if (sample.queueStatus === "unavailable" && sample.counts !== null) throw new Error();
    if (!sample.activity || ![sample.activity.lastCompletedAt, sample.activity.lastFailedAt]
      .every((value) => value === null || validTime(value))) throw new Error();
    if (sample.workObservedSince !== null && (!validTime(sample.workObservedSince) ||
      Date.parse(sample.workObservedSince) > Date.parse(sample.observedAt))) throw new Error();
    if (role === "communication-scheduler" && (!sample.scheduler ||
      typeof sample.scheduler.inFlight !== "boolean" ||
      ![sample.scheduler.lastStartedAt, sample.scheduler.lastSucceededAt, sample.scheduler.lastFailedAt]
        .every((value) => value === null || validTime(value)))) throw new Error();
    if (role !== "communication-scheduler" && sample.scheduler !== null) throw new Error();
  } catch {
    return { id, status: "unavailable", reason: "invalid_heartbeat" };
  }
  const ageMs = Math.max(0, now - Date.parse(sample.observedAt));
  const safe = { id, observedAt: new Date(sample.observedAt).toISOString(), ageMs, thresholdMs: WORKER_HEARTBEAT_STALE_MS };
  if (ageMs > WORKER_HEARTBEAT_STALE_MS) return { ...safe, status: "unhealthy", reason: "stale_heartbeat" };
  if (sample.queueStatus !== "ok") return { ...safe, status: "unavailable", reason: "queue_unavailable" };
  const counts = sample.counts!;
  const result = { ...safe, waiting: counts.waiting + counts.prioritized, active: counts.active, delayed: counts.delayed, failed: counts.failed };
  // BullMQ retains failed jobs; that lifetime count is informational, not an
  // alarm that can never recover. This signal includes retryable attempts.
  if (sample.activity.lastFailedAt !== null && now - Date.parse(sample.activity.lastFailedAt) <= WORKER_RECENT_FAILURE_MS)
    return { ...result, status: "unhealthy", reason: "recent_failed_attempt", thresholdMs: WORKER_RECENT_FAILURE_MS };
  if (counts.paused > 0) return { ...result, status: "unhealthy", reason: "paused_jobs" };
  if (result.waiting > WORKER_QUEUE_BACKLOG_LIMIT) return { ...result, status: "unhealthy", reason: "queue_backlog", limit: WORKER_QUEUE_BACKLOG_LIMIT };
  // Progress is a heuristic, not proof of an individual stalled job. Imports
  // get a larger budget than email delivery; eligible-job age is not collected.
  const progressBudget = role === "data-import" ? 30 * 60_000 : 15 * 60_000;
  if (role !== "communication-scheduler" && (result.waiting > 0 || counts.active > 0) && sample.workObservedSince !== null &&
    now - Math.max(Date.parse(sample.workObservedSince), Date.parse(sample.activity.lastCompletedAt ?? sample.instanceStartedAt)) > progressBudget)
    return { ...result, status: "unhealthy", reason: "work_without_recent_completion", thresholdMs: progressBudget };
  if (sample.scheduler) {
    const state = sample.scheduler;
    const success = state.lastSucceededAt === null ? null : Date.parse(state.lastSucceededAt);
    const failure = state.lastFailedAt === null ? null : Date.parse(state.lastFailedAt);
    const budget = Math.max(3 * 60_000, 3 * schedulerIntervalMs);
    if (failure !== null && (success === null || failure > success)) return { ...result, status: "unhealthy", reason: "scheduler_failed" };
    if (state.inFlight && (state.lastStartedAt === null || now - Date.parse(state.lastStartedAt) > Math.max(budget, 10 * 60_000)))
      return { ...result, status: "unhealthy", reason: "scheduler_run_overdue" };
    if (now - (success ?? Date.parse(sample.instanceStartedAt)) > budget)
      return { ...result, status: "unhealthy", reason: "scheduler_success_overdue" };
  }
  return { ...result, status: "ok", reason: "healthy" };
};

export const readWorkerHeartbeats = async (config: OperationsConfig, now = Date.now()): Promise<OperationsCheck[]> => {
  const redis = await getOperationsRedis();
  if (redis.status !== "ready") throw new Error("Redis unavailable");
  const values = await redis.mget(...config.expectedWorkers.map((role) => workerHeartbeatKey(config.namespace, role)));
  const interval = Number(process.env.COMMUNICATION_SCHEDULER_INTERVAL_MS);
  return values.map((value, index) => evaluateWorkerHeartbeat(config.expectedWorkers[index], value, now,
    Number.isFinite(interval) && interval >= 10_000 ? interval : 60_000));
};
