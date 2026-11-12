import { bullMqProducerConnection, bullMqPrefix } from "@/infrastructure/redis/redis.js";
import { createE2EDisabledQueue } from "@/infrastructure/queues/e2e-disabled.queue.js";
import { withQueueErrorLogging } from "@/infrastructure/queues/queue-observability.js";
import { isE2ETestMode } from "@/config/e2e-mode.js";
import { Queue, type Job, type JobState } from "bullmq";

export const communicationEmailQueueName = "communication-emails" as const;

export type CommunicationEmailJobData = {
  tenantId: string;
  emailLogId: string;
  automationId?: string;
  userId?: string;
  relatedEntityId?: string;
};

export const communicationEmailQueue = isE2ETestMode()
  ? createE2EDisabledQueue<CommunicationEmailJobData>(
      communicationEmailQueueName,
    )
  : withQueueErrorLogging(
      new Queue<CommunicationEmailJobData>(communicationEmailQueueName, {
        connection: bullMqProducerConnection,
        prefix: bullMqPrefix,

        defaultJobOptions: {
          attempts: 3,

          backoff: {
            type: "exponential",
            delay: 60_000,
          },

          removeOnComplete: {
            age: 60 * 60 * 24 * 14,
            count: 5_000,
          },

          removeOnFail: {
            age: 60 * 60 * 24 * 30,
            count: 10_000,
          },
        },
      }),
      communicationEmailQueueName,
    );

export const enqueueCommunicationEmail = async (
  data: CommunicationEmailJobData,
  deduplicationKey: string,
  options: {
    delay?: number;
    jobIdSuffix?: string;
    allowCompletedRetry?: boolean;
  } = {},
) => {
  const jobId = `email-${deduplicationKey}${
    options.jobIdSuffix ? `-${options.jobIdSuffix}` : ""
  }`;

  const runnableStates = new Set<JobState>([
    "active",
    "delayed",
    "prioritized",
    "waiting",
    "waiting-children",
  ]);
  const inspect = async (
    job: Job<CommunicationEmailJobData>,
    action:
      "existing" | "submitted" | "reactivated_failed" | "reactivated_completed",
  ) => {
    const state = await job.getState();
    return {
      job,
      jobId,
      state,
      action,
      queueAccepted: runnableStates.has(state as JobState),
      newlyQueued:
        action !== "existing" && runnableStates.has(state as JobState),
    };
  };
  const retryFinishedJob = async (
    job: Job<CommunicationEmailJobData>,
    state: "failed" | "completed",
    action: "reactivated_failed" | "reactivated_completed",
  ) => {
    try {
      await job.retry(state, {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      return inspect(job, action);
    } catch (error) {
      // Two schedulers may observe the same finished job. If another scheduler
      // won the retry race, reuse its runnable job; otherwise fail closed.
      const currentState = await job.getState();
      if (runnableStates.has(currentState as JobState)) {
        return {
          job,
          jobId,
          state: currentState,
          action: "existing" as const,
          queueAccepted: true,
          newlyQueued: false,
        };
      }
      throw error;
    }
  };

  const getJob = communicationEmailQueue.getJob?.bind(communicationEmailQueue);
  const existing = getJob ? await getJob(jobId) : null;
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      return retryFinishedJob(existing, "failed", "reactivated_failed");
    }
    if (state === "completed" && options.allowCompletedRetry === true) {
      return retryFinishedJob(existing, "completed", "reactivated_completed");
    }
    return {
      job: existing,
      jobId,
      state,
      action: "existing" as const,
      queueAccepted: runnableStates.has(state as JobState),
      newlyQueued: false,
    };
  }

  const job = await communicationEmailQueue.add("send", data, {
    jobId,
    ...(options.delay && options.delay > 0 ? { delay: options.delay } : {}),
  });
  return inspect(job, "submitted");
};
