import { Queue, type Job, type JobState } from "bullmq";

import { isE2ETestMode } from "@/config/e2e-mode.js";
import { createE2EDisabledQueue } from "@/infrastructure/queues/e2e-disabled.queue.js";
import { withQueueErrorLogging } from "@/infrastructure/queues/queue-observability.js";
import { bullMqProducerConnection, bullMqPrefix } from "@/infrastructure/redis/redis.js";

export const dataImportQueueName = "data-imports" as const;

export type DataImportJobData = {
  tenantId: string;
  sessionId: string;
  operation?: "import" | "rollback";
  rollbackRevision?: number;
  entityType:
    | "customers"
    | "products"
    | "bookings"
    | "membership-plans"
    | "memberships"
    | "credits"
    | "voucher-products"
    | "vouchers";
};

export const dataImportQueue = isE2ETestMode()
  ? createE2EDisabledQueue<DataImportJobData>(dataImportQueueName)
  : withQueueErrorLogging(
      new Queue<DataImportJobData>(dataImportQueueName, {
        connection: bullMqProducerConnection,
        prefix: bullMqPrefix,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: {
            age: 60 * 60 * 24 * 30,
            count: 5_000,
          },
          removeOnFail: {
            age: 60 * 60 * 24 * 30,
            count: 5_000,
          },
        },
      }),
      dataImportQueueName,
    );

const runnableStates = new Set<JobState>([
  "active",
  "delayed",
  "prioritized",
  "waiting",
  "waiting-children",
]);

type DataImportQueueAction =
  "existing" | "submitted" | "reactivated_failed" | "reactivated_completed";

const inspectDataImportJob = async (
  job: Job<DataImportJobData>,
  jobId: string,
  action: DataImportQueueAction,
) => {
  const state = await job.getState();
  return {
    job,
    jobId,
    state,
    action,
    queueAccepted: runnableStates.has(state as JobState),
  };
};

const retryFinishedDataImportJob = async (
  job: Job<DataImportJobData>,
  jobId: string,
  state: "failed" | "completed",
  action: "reactivated_failed" | "reactivated_completed",
) => {
  try {
    await job.retry(state, {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    return inspectDataImportJob(job, jobId, action);
  } catch (error) {
    // Two requests may try to resume the same import. Reuse the winner's job
    // if it is runnable; otherwise surface the queue failure to the caller.
    const currentState = await job.getState();
    if (runnableStates.has(currentState as JobState)) {
      return {
        job,
        jobId,
        state: currentState,
        action: "existing" as const,
        queueAccepted: true,
      };
    }
    throw error;
  }
};

export const enqueueDataImport = async (data: DataImportJobData) => {
  const jobId = "data-import-" + data.sessionId;
  const getJob = dataImportQueue.getJob?.bind(dataImportQueue);
  const existing = getJob ? await getJob(jobId) : null;

  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      return retryFinishedDataImportJob(
        existing,
        jobId,
        "failed",
        "reactivated_failed",
      );
    }
    if (state === "completed") {
      return retryFinishedDataImportJob(
        existing,
        jobId,
        "completed",
        "reactivated_completed",
      );
    }
    return {
      job: existing,
      jobId,
      state,
      action: "existing" as const,
      queueAccepted: runnableStates.has(state as JobState),
    };
  }

  const job = await dataImportQueue.add(
    "execute",
    { ...data, operation: "import" },
    { jobId },
  );
  return inspectDataImportJob(job, jobId, "submitted");
};

export const enqueueDataImportRollback = async (
  data: DataImportJobData & { rollbackRevision: number },
) => {
  const jobId = `data-import-rollback-${data.sessionId}-r${data.rollbackRevision}`;
  const getJob = dataImportQueue.getJob?.bind(dataImportQueue);
  const existing = getJob ? await getJob(jobId) : null;
  if (existing) {
    const state = await existing.getState();
    if (state === "failed")
      return retryFinishedDataImportJob(
        existing,
        jobId,
        "failed",
        "reactivated_failed",
      );
    if (state === "completed")
      return retryFinishedDataImportJob(
        existing,
        jobId,
        "completed",
        "reactivated_completed",
      );
    return {
      job: existing,
      jobId,
      state,
      action: "existing" as const,
      queueAccepted: runnableStates.has(state as JobState),
    };
  }
  const job = await dataImportQueue.add(
    "rollback",
    { ...data, operation: "rollback" },
    { jobId },
  );
  return inspectDataImportJob(job, jobId, "submitted");
};
