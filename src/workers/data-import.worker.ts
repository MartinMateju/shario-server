import "dotenv/config";
import { ensureOpenStudioLocationIndex } from "@/modules/product/open-studio-location-index.js";

import { pathToFileURL } from "node:url";

import { Job, Worker } from "bullmq";

import { logger } from "@/config/logger.js";
import connectDB, {
  closeDatabaseConnection,
} from "@/infrastructure/database/connect-db.js";
import { createGracefulShutdown } from "@/infrastructure/lifecycle/graceful-shutdown.js";
import { startWorkerOperationalTelemetry } from "@/infrastructure/queues/worker-operational-telemetry.js";
import {
  dataImportQueue,
  dataImportQueueName,
  type DataImportJobData,
} from "@/infrastructure/queues/data-import.queue.js";
import { bullMqWorkerConnection, bullMqPrefix } from "@/infrastructure/redis/redis.js";
import { processCustomerImportSession } from "@/modules/data-import/services/data-import-execution.service.js";
import { processProductImportSession } from "@/modules/data-import/services/product-import-execution.service.js";
import { processBookingImportSession } from "@/modules/data-import/services/booking-import-execution.service.js";
import { processMembershipPlanImportSession } from "@/modules/data-import/services/membership-plan-import-execution.service.js";
import { processMembershipImportSession } from "@/modules/data-import/services/membership-import-execution.service.js";
import { processCreditImportSession } from "@/modules/data-import/services/credit-import-execution.service.js";
import { processVoucherProductImportSession } from "@/modules/data-import/services/voucher-product-import-execution.service.js";
import { processVoucherImportSession } from "@/modules/data-import/services/voucher-import-execution.service.js";
import { processImportRollbackSession } from "@/modules/data-import/services/data-import-rollback.service.js";
import DataImportSessionModel from "@/modules/data-import/data-import-session.model.js";
import { registerWorkspaceNotificationPublisher } from "@/modules/workspace-notifications/workspace-notification.bootstrap.js";
import { emitImportTerminalNotification } from "@/modules/workspace-notifications/workspace-notification.business-events.js";

const importProcessors = {
  customers: processCustomerImportSession,
  products: processProductImportSession,
  bookings: processBookingImportSession,
  "membership-plans": processMembershipPlanImportSession,
  memberships: processMembershipImportSession,
  credits: processCreditImportSession,
  "voucher-products": processVoucherProductImportSession,
  vouchers: processVoucherImportSession,
} as const;

export const isTerminalDataImportFailure = (
  job: Job<DataImportJobData> | undefined,
): boolean => {
  if (!job || job.data.operation === "rollback") return false;
  const attempts = Math.max(1, Number(job.opts.attempts ?? 1));
  return Number(job.attemptsMade) >= attempts;
};

export const emitTerminalDataImportFailure = async (
  job: Job<DataImportJobData>,
): Promise<boolean> => {
  if (!isTerminalDataImportFailure(job)) return false;

  const { tenantId, sessionId, entityType } = job.data;
  const session = await DataImportSessionModel.findOne({
    _id: sessionId,
    tenant: tenantId,
  })
    .select("queuedBy createdBy")
    .lean()
    .exec();
  const recipientUserId = String(session?.queuedBy || session?.createdBy || "");
  if (!recipientUserId) return false;

  return emitImportTerminalNotification({
    tenantId,
    sessionId,
    recipientUserId,
    entityType,
    status: "failed",
  });
};

export const processDataImportJob = async (job: Job<DataImportJobData>) => {
  if (
    !job.data.tenantId ||
    !job.data.sessionId ||
    !(job.data.entityType in importProcessors)
  ) {
    throw new Error("Data import job payload is invalid.");
  }
  if (job.data.operation === "rollback") {
    if (
      !Number.isSafeInteger(job.data.rollbackRevision) ||
      Number(job.data.rollbackRevision) < 1
    )
      throw new Error("Data import rollback job payload is invalid.");
    return processImportRollbackSession({
      tenantId: job.data.tenantId,
      sessionId: job.data.sessionId,
      revision: Number(job.data.rollbackRevision),
    });
  }
  if (job.data.operation && job.data.operation !== "import")
    throw new Error("Data import job operation is invalid.");
  const processSession = importProcessors[job.data.entityType];
  return processSession({
    tenantId: job.data.tenantId,
    sessionId: job.data.sessionId,
  });
};

export const createDataImportWorker = () =>
  new Worker<DataImportJobData>(dataImportQueueName, processDataImportJob, {
    connection: bullMqWorkerConnection,
      prefix: bullMqPrefix,
    concurrency: Number(process.env.DATA_IMPORT_WORKER_CONCURRENCY || 2),
    lockDuration: 10 * 60_000,
  });

export const startDataImportWorker = async () => {
  await connectDB();
  await ensureOpenStudioLocationIndex();
  registerWorkspaceNotificationPublisher();
  const worker = createDataImportWorker();
  const telemetry = startWorkerOperationalTelemetry({
    role: "data-import",
    queueName: dataImportQueueName,
    queue: dataImportQueue,
    emit: (sample) => logger.info(sample, "Worker operational sample."),
  });
  worker.on("completed", (job) => {
    telemetry.recordCompleted();
    logger.info(
      { jobId: job.id, queue: dataImportQueueName },
      "Data import completed.",
    );
  });
  worker.on("failed", (job, error) => {
    telemetry.recordFailedAttempt();
    logger.error(
      { err: error, jobId: job?.id, queue: dataImportQueueName },
      "Data import failed.",
    );
    if (job && isTerminalDataImportFailure(job)) {
      void emitTerminalDataImportFailure(job).catch((notificationError) => {
        logger.error(
          {
            err: notificationError,
            jobId: job.id,
            queue: dataImportQueueName,
          },
          "Terminal data import notification failed.",
        );
      });
    }
  });
  worker.on("error", (error) => {
    logger.error({ err: error }, "Data import worker error.");
  });

  const shutdown = createGracefulShutdown({
    markNotReady: () => undefined,
    stopSchedulers: () => {
      telemetry.stop();
      return worker.pause(true);
    },
    drainSteps: [{ name: "data-import-worker", run: () => worker.close() }],
    forceAfterDrainTimeout: () => worker.close(true),
    cleanupSteps: [
      { name: "data-import-queue", run: () => dataImportQueue.close() },
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
          "Data import worker shutdown failed.",
        );
        process.exit(1);
      });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  logger.info({ queue: dataImportQueueName }, "Data import worker running.");
  return { worker, shutdown };
};

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
);
if (isDirectExecution) {
  void startDataImportWorker().catch(async (error) => {
    logger.fatal({ err: error }, "Data import worker startup failed.");
    await Promise.allSettled([
      dataImportQueue.close(),
      closeDatabaseConnection(),
    ]);
    process.exit(1);
  });
}
