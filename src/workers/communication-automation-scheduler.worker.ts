import "dotenv/config";

import { pathToFileURL } from "node:url";

import { logger } from "@/config/logger.js";
import connectDB, {
  closeDatabaseConnection,
} from "@/infrastructure/database/connect-db.js";
import { createGracefulShutdown } from "@/infrastructure/lifecycle/graceful-shutdown.js";
import {
  communicationEmailQueue,
  communicationEmailQueueName,
} from "@/infrastructure/queues/communication-email.queue.js";
import { startWorkerOperationalTelemetry } from "@/infrastructure/queues/worker-operational-telemetry.js";
import { runAutomatedCommunications } from "@/modules/communication-automations/services/communication-automation-runner.service.js";
import { runCustomOrderDeadlineReminders } from "@/modules/custom-orders/custom-order.reminders.js";

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;

const parsedInterval = Number(process.env.COMMUNICATION_SCHEDULER_INTERVAL_MS);

const INTERVAL_MS =
  Number.isFinite(parsedInterval) && parsedInterval >= MIN_INTERVAL_MS
    ? parsedInterval
    : DEFAULT_INTERVAL_MS;

export const startCommunicationAutomationScheduler = async () => {
  await connectDB();

  let currentRun: Promise<void> | null = null;
  let isShuttingDown = false;
  let intervalId: NodeJS.Timeout | null = null;
  const telemetry = startWorkerOperationalTelemetry({
    role: "communication-scheduler",
    queueName: communicationEmailQueueName,
    queue: communicationEmailQueue,
    emit: (sample) => logger.info(sample, "Worker operational sample."),
  });

  const runSchedulerTick = async (): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    if (currentRun) {
      logger.warn("Previous communication scheduler run is still running.");
      return;
    }

    const startedAt = Date.now();
    telemetry.recordSchedulerStarted();
    const execution = (async () => {
      try {
        logger.info("Checking communication automations.");

        // Independent scans must both run even when one subsystem is unavailable.
        const [communications, reminders] = await Promise.allSettled([
          runAutomatedCommunications(),
          runCustomOrderDeadlineReminders(),
        ]);
        if (reminders.status === "fulfilled") {
          logger.info({ result: reminders.value }, "Custom order deadline reminder check finished.");
        }
        if (communications.status === "rejected") throw communications.reason;
        if (reminders.status === "rejected") throw reminders.reason;
        if (reminders.value.failed > 0) {
          throw new Error(`${reminders.value.failed} custom order reminder(s) failed; retry is pending.`);
        }
        const result = communications.value;
        telemetry.recordSchedulerFinished(
          true,
          result ? { ...result } : undefined,
        );

        logger.info(
          {
            durationMs: Date.now() - startedAt,
            result: result ?? null,
          },
          "Communication automation check finished.",
        );
      } catch (error) {
        telemetry.recordSchedulerFinished(false);
        logger.error(
          {
            err: error,
            durationMs: Date.now() - startedAt,
          },
          "Communication automation scheduler failed.",
        );
      }
    })();

    currentRun = execution;

    try {
      await execution;
    } finally {
      if (currentRun === execution) {
        currentRun = null;
      }
    }
  };

  const shutdown = createGracefulShutdown({
    markNotReady: () => {
      isShuttingDown = true;
    },
    stopSchedulers: () => {
      telemetry.stop();
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    drainSteps: [
      {
        name: "communication-scheduler-tick",
        run: () => currentRun || Promise.resolve(),
      },
    ],
    cleanupSteps: [
      {
        name: "communication-email-queue",
        run: () => communicationEmailQueue.close(),
      },
      { name: "mongodb", run: closeDatabaseConnection },
    ],
    drainTimeoutMs: Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || 30_000),
    cleanupTimeoutMs: Number(process.env.SHUTDOWN_CLEANUP_TIMEOUT_MS || 20_000),
  });

  const beginShutdown = (signal: string, failure = false): void => {
    void shutdown(signal)
      .then((result) => {
        process.exit(
          failure ||
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
          "Communication scheduler shutdown failed.",
        );
        process.exit(1);
      });
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    beginShutdown(signal);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  process.once("unhandledRejection", (error) => {
    logger.error(
      { err: error },
      "Unhandled rejection in communication scheduler.",
    );
    beginShutdown("unhandledRejection", true);
  });

  process.once("uncaughtException", (error) => {
    logger.fatal(
      { err: error },
      "Uncaught exception in communication scheduler.",
    );
    beginShutdown("uncaughtException", true);
  });

  intervalId = setInterval(() => {
    void runSchedulerTick();
  }, INTERVAL_MS);

  logger.info(
    {
      intervalMs: INTERVAL_MS,
      intervalSeconds: INTERVAL_MS / 1000,
    },
    "Communication automation scheduler started.",
  );

  await runSchedulerTick();

  return { shutdown, runSchedulerTick };
};

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
);

if (isDirectExecution) {
  void startCommunicationAutomationScheduler().catch(async (error) => {
    logger.fatal(
      { err: error },
      "Communication automation scheduler startup failed.",
    );
    await Promise.allSettled([
      communicationEmailQueue.close(),
      closeDatabaseConnection(),
    ]);
    process.exit(1);
  });
}
