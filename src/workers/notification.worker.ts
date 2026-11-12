import { logger } from "@/config/logger.js";
import connectDB, {
  closeDatabaseConnection,
} from "@/infrastructure/database/connect-db.js";
import {
  closeEmailTransporter,
} from "@/infrastructure/email/nodemailer.client.js";
import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import { createGracefulShutdown } from "@/infrastructure/lifecycle/graceful-shutdown.js";
import {
  notificationQueue,
  notificationQueueName,
} from "@/infrastructure/queues/notification.queue.js";
import { bullMqWorkerConnection, bullMqPrefix } from "@/infrastructure/redis/redis.js";
import { notificationService } from "@/modules/notification/services/notification.service.js";
import { Job, Worker } from "bullmq";
import { pathToFileURL } from "node:url";

import "dotenv/config";

type NotificationJobData = {
  tenantId: string;
  sentBy: string;
  type: string;
  recipient: string;
  subject: string;
  html: string;
  userId?: string | null;
  bookingId?: string | null;
  location?: string;
};

const normalizeEmail = (email: string): string => {
  return email.trim().toLowerCase();
};

const validateJobPayload = (data: NotificationJobData): void => {
  if (!data.tenantId) {
    throw new Error("Notification job is missing tenantId.");
  }

  if (!data.sentBy) {
    throw new Error("Notification job is missing sentBy.");
  }

  if (!data.type || !data.recipient || !data.subject || !data.html) {
    throw new Error("Notification job payload is incomplete.");
  }
};

export const processNotificationJob = async (job: Job<NotificationJobData>) => {
  const data = job.data;

  validateJobPayload(data);

  const recipientEmail = normalizeEmail(data.recipient);

  try {
    const result = await sendEmail({
      tenantId: data.tenantId,
      to: recipientEmail,
      subject: data.subject,
      html: data.html,
    });

    const notification = await notificationService.createEmailNotification(
      data.tenantId,
      data.sentBy,
      {
        title: data.subject,
        emailType: data.type,
        subject: data.subject,
        globalMessage: data.html,
        relatedBooking: data.bookingId || null,
        recipients: [
          {
            user: data.userId || undefined,
            userCustomId: "",
            firstname: "",
            lastname: "",
            email: recipientEmail,
            privateMessage: "",
            photoUrl: "",
            imageCount: 0,
            itemCount: null,
            recipientIndex: 0,
          },
        ],
      },
    );

    return {
      success: true,
      notificationId: String(notification._id),
      providerMessageId: result?.providerMessageId || null,
    };
  } catch (error) {
    logger.error(
      {
        err: error,
        jobId: job.id,
        tenantId: data.tenantId,
        recipient: recipientEmail,
      },
      "Failed to process notification job.",
    );

    throw error;
  }
};

export const createNotificationWorker = () =>
  new Worker<NotificationJobData>(
    notificationQueueName,
    processNotificationJob,
    {
      connection: bullMqWorkerConnection,
      prefix: bullMqPrefix,
      concurrency: Number(process.env.NOTIFICATION_WORKER_CONCURRENCY || 5),
      lockDuration: 120_000,
      removeOnComplete: {
        age: 60 * 60 * 24 * 7,
        count: 1000,
      },
      removeOnFail: {
        age: 60 * 60 * 24 * 30,
        count: 5000,
      },
    },
  );

export const startNotificationWorker = async () => {
  await connectDB();

  const worker = createNotificationWorker();

  worker.on("completed", (job) => {
    logger.info(
      {
        jobId: job.id,
        queue: notificationQueueName,
      },
      "Notification job completed.",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      {
        err: error,
        jobId: job?.id,
        queue: notificationQueueName,
      },
      "Notification job failed.",
    );
  });

  worker.on("error", (error) => {
    logger.error({ err: error }, "Notification worker error.");
  });

  const shutdown = createGracefulShutdown({
    markNotReady: () => undefined,
    stopSchedulers: () => worker.pause(true),
    drainSteps: [{ name: "notification-worker", run: () => worker.close() }],
    forceAfterDrainTimeout: () => worker.close(true),
    cleanupSteps: [
      { name: "notification-queue", run: () => notificationQueue.close() },
      { name: "default-email-transporter", run: closeEmailTransporter },
      { name: "mongodb", run: closeDatabaseConnection },
    ],
    drainTimeoutMs: Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || 30_000),
    cleanupTimeoutMs: Number(process.env.SHUTDOWN_CLEANUP_TIMEOUT_MS || 20_000),
  });

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal)
      .then((result) => {
        process.exit(
          result.drainTimedOut ||
            result.errors.length > 0 ||
            result.cleanupTimedOut.length > 0
            ? 1
            : 0,
        );
      })
      .catch((error) => {
        logger.fatal(
          { err: error, signal },
          "Notification worker shutdown failed.",
        );
        process.exit(1);
      });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  logger.info(
    {
      queue: notificationQueueName,
    },
    "Notification worker running.",
  );

  return { worker, shutdown };
};

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
);

if (isDirectExecution) {
  void startNotificationWorker().catch(async (error) => {
    logger.fatal({ err: error }, "Notification worker startup failed.");
    await Promise.allSettled([
      notificationQueue.close(),
      closeDatabaseConnection(),
    ]);
    closeEmailTransporter();
    process.exit(1);
  });
}
