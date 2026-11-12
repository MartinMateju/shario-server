import { bullMqProducerConnection, bullMqPrefix } from "@/infrastructure/redis/redis.js";
import { createE2EDisabledQueue } from "@/infrastructure/queues/e2e-disabled.queue.js";
import { withQueueErrorLogging } from "@/infrastructure/queues/queue-observability.js";
import { isE2ETestMode } from "@/config/e2e-mode.js";
import { Queue } from "bullmq";

export const notificationQueueName = "notifications" as const;

export type NotificationJobData = {
  tenantId: string;
  type: string;

  userId?: string | null;
  bookingId?: string | null;

  recipient: string;
  subject: string;
  html: string;
};

export const notificationQueue = isE2ETestMode()
  ? createE2EDisabledQueue<NotificationJobData>(
      notificationQueueName,
    )
  : withQueueErrorLogging(
      new Queue<NotificationJobData>(notificationQueueName, {
        connection: bullMqProducerConnection,
        prefix: bullMqPrefix,

        defaultJobOptions: {
          attempts: 5,

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
      notificationQueueName,
    );
