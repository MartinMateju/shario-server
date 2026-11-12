export const WORKER_TELEMETRY_INTERVAL_MS = 60_000;
export const WORKER_TELEMETRY_TIMEOUT_MS = 2_000;

const QUEUE_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "failed",
  "paused",
  "waiting-children",
] as const;
type QueueState = (typeof QUEUE_STATES)[number];
type QueueCounts = Record<QueueState, number>;
type WorkerRole =
  | "communication-email"
  | "communication-scheduler"
  | "data-import";
type UnavailableReason =
  | "timeout"
  | "probe_in_flight"
  | "probe_failed"
  | "unsupported"
  | "invalid_counts"
  | "stopped";
type QueueObservation =
  | { status: "ok"; reason: null; counts: QueueCounts }
  | {
      status: "unavailable";
      reason: UnavailableReason;
      counts: null;
    };

const SCHEDULER_RESULT_FIELDS = [
  "checked", "queued", "skipped", "suppressed", "failed",
] as const;
type SchedulerResult = Record<
  (typeof SCHEDULER_RESULT_FIELDS)[number],
  number | null
>;
type SchedulerObservation = {
  inFlight: boolean;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastDurationMs: number | null;
  lastResult: SchedulerResult | null;
};

export type WorkerOperationalSample = {
  event: "worker_operational_sample";
  schemaVersion: 1;
  role: WorkerRole;
  queue: "communication-emails" | "data-imports";
  instanceStartedAt: string;
  observedAt: string;
  uptimeMs: number;
  queueObservation: QueueObservation;
  lastQueueSampleSucceededAt: string | null;
  oldestEligibleJobAgeMs: null;
  eligibleAgeCoverage: "not_collected";
  activity: {
    completedSinceStart: number;
    failedAttemptsSinceStart: number;
    lastCompletedAt: string | null;
    lastFailedAt: string | null;
  };
  scheduler: SchedulerObservation | null;
};

const countValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

const unavailable = (reason: UnavailableReason): QueueObservation => ({
  status: "unavailable",
  reason,
  counts: null,
});

/** Read-only telemetry. It never claims job eligibility or changes API readiness. */
export const startWorkerOperationalTelemetry = ({
  role,
  queueName,
  queue,
  emit,
}: {
  role: WorkerRole;
  queueName: WorkerOperationalSample["queue"];
  queue: {
    getJobCounts?: (...states: QueueState[]) => Promise<Record<string, number>>;
  };
  emit: (sample: WorkerOperationalSample) => void;
}) => {
  const startedAt = Date.now();
  let stopped = false;
  let inFlight: Promise<QueueObservation> | null = null;
  let cancelPendingSample: (() => void) | null = null;
  let lastQueueSampleSucceededAt: string | null = null;
  const activity: WorkerOperationalSample["activity"] = {
    completedSinceStart: 0,
    failedAttemptsSinceStart: 0,
    lastCompletedAt: null,
    lastFailedAt: null,
  };
  const scheduler: SchedulerObservation | null =
    role === "communication-scheduler"
      ? {
          inFlight: false,
          lastStartedAt: null,
          lastSucceededAt: null,
          lastFailedAt: null,
          lastDurationMs: null,
          lastResult: null,
        }
      : null;
  let schedulerStartedAt: number | null = null;

  const collectCounts = (): Promise<QueueObservation> => {
    if (inFlight) return Promise.resolve(unavailable("probe_in_flight"));
    if (!queue.getJobCounts) return Promise.resolve(unavailable("unsupported"));

    const operation = Promise.resolve()
      .then(() => queue.getJobCounts!(...QUEUE_STATES))
      .then((raw): QueueObservation => {
        const counts = {} as QueueCounts;
        for (const state of QUEUE_STATES) {
          const value = countValue(raw?.[state]);
          if (value === null) return unavailable("invalid_counts");
          counts[state] = value;
        }
        return { status: "ok", reason: null, counts };
      })
      .catch(() => unavailable("probe_failed"));
    inFlight = operation;
    // A response deadline does not cancel Redis. Keep the operation locked until
    // it actually settles, so a stalled connection cannot accumulate requests.
    void operation.then(() => {
      if (inFlight === operation) inFlight = null;
    });

    return new Promise((resolve) => {
      let finished = false;
      const finish = (observation: QueueObservation) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        cancelPendingSample = null;
        resolve(observation);
      };
      const deadline = setTimeout(
        () => finish(unavailable("timeout")),
        WORKER_TELEMETRY_TIMEOUT_MS,
      );
      deadline.unref();
      cancelPendingSample = () => finish(unavailable("stopped"));
      void operation.then(finish);
    });
  };

  const sampleNow = async (): Promise<void> => {
    if (stopped) return;
    const queueObservation = await collectCounts();
    if (stopped) return;
    const now = Date.now();
    if (queueObservation.status === "ok") {
      lastQueueSampleSucceededAt = new Date(now).toISOString();
    }
    try {
      emit({
        event: "worker_operational_sample",
        schemaVersion: 1,
        role,
        queue: queueName,
        instanceStartedAt: new Date(startedAt).toISOString(),
        observedAt: new Date(now).toISOString(),
        uptimeMs: Math.max(0, now - startedAt),
        queueObservation,
        lastQueueSampleSucceededAt,
        // BullMQ clears delay on promotion; its creation timestamp cannot tell
        // us when a retried/deferred job became eligible. Do not invent an age.
        oldestEligibleJobAgeMs: null,
        eligibleAgeCoverage: "not_collected",
        activity: { ...activity },
        scheduler: scheduler
          ? {
              ...scheduler,
              lastResult: scheduler.lastResult ? { ...scheduler.lastResult } : null,
            }
          : null,
      });
    } catch {
      // Telemetry output must not stop job processing or trigger a retry.
    }
  };

  const interval = setInterval(() => void sampleNow(), WORKER_TELEMETRY_INTERVAL_MS);
  interval.unref();
  void sampleNow();

  return {
    sampleNow,
    stop: () => {
      stopped = true;
      clearInterval(interval);
      cancelPendingSample?.();
    },
    recordCompleted: () => {
      if (stopped) return;
      activity.completedSinceStart += 1;
      activity.lastCompletedAt = new Date().toISOString();
    },
    recordFailedAttempt: () => {
      if (stopped) return;
      activity.failedAttemptsSinceStart += 1;
      activity.lastFailedAt = new Date().toISOString();
    },
    recordSchedulerStarted: () => {
      if (stopped || !scheduler) return;
      schedulerStartedAt = Date.now();
      scheduler.inFlight = true;
      scheduler.lastStartedAt = new Date(schedulerStartedAt).toISOString();
    },
    recordSchedulerFinished: (
      succeeded: boolean,
      result?: Record<string, unknown>,
    ) => {
      if (stopped || !scheduler) return;
      const now = Date.now();
      scheduler.inFlight = false;
      scheduler.lastDurationMs = schedulerStartedAt === null
        ? null
        : Math.max(0, now - schedulerStartedAt);
      schedulerStartedAt = null;
      if (succeeded) scheduler.lastSucceededAt = new Date(now).toISOString();
      else scheduler.lastFailedAt = new Date(now).toISOString();
      scheduler.lastResult = succeeded && result
        ? Object.fromEntries(
            SCHEDULER_RESULT_FIELDS.map((field) => [field, countValue(result[field])]),
          ) as SchedulerResult
        : null;
    },
  };
};
