import "dotenv/config";

import { createApp } from "@/app/create-app.js";
import { env } from "@/config/env.js";
import { logger } from "@/config/logger.js";
import connectDB, {
  closeDatabaseConnection,
} from "@/infrastructure/database/connect-db.js";
import { clearEmailServiceCache } from "@/infrastructure/email/email-runner.service.js";
import { closeEmailTransporter } from "@/infrastructure/email/nodemailer.client.js";
import { createGracefulShutdown } from "@/infrastructure/lifecycle/graceful-shutdown.js";
import {
  closeHttpServer,
  waitForHttpServerListening,
} from "@/infrastructure/lifecycle/http-server.js";
import {
  markRuntimeReady,
  markRuntimeShuttingDown,
  markRuntimeStarting,
} from "@/infrastructure/lifecycle/runtime-readiness.js";
import { communicationEmailQueue } from "@/infrastructure/queues/communication-email.queue.js";
import { dataImportQueue } from "@/infrastructure/queues/data-import.queue.js";
import { notificationQueue } from "@/infrastructure/queues/notification.queue.js";
import { closeRedisConnection } from "@/infrastructure/redis/redis.js";
import { CronSupervisor } from "@/infrastructure/scheduling/cron-supervisor.js";
import { sendUpcomingBookingReminders } from "@/modules/access-codes/jobs/access-code-reminder.job.js";
import { sendOutAccessCodes } from "@/modules/access-codes/jobs/access-code-notification.job.js";
import { generateDueAiBriefings } from "@/modules/ai/services/ai-scheduler.service.js";
import { reconcileAiUsageReservations } from "@/modules/ai/services/ai-usage.service.js";
import { processPendingKnowledgeEmbeddings } from "@/modules/ai/services/knowledge-retrieval.service.js";
import { removeExpiredTempBookingsJob } from "@/modules/booking/jobs/booking-cleanup.job.js";
import { markBookingsAsDelivered } from "@/modules/booking/jobs/booking.status.job.js";
import { processPendingCommunicationDeliveries } from "@/modules/communications/services/delivery-processing.service.js";
import { ensureKnowledgeTextIndex } from "@/modules/communications/knowledge-text-index.js";
import { enforceAllCommunicationRetention } from "@/modules/communications/services/retention.service.js";
import { reconcilePaidOrderInvoices } from "@/modules/invoice/invoice.service.js";
import { isNativeInvoicingEnabled } from "@/modules/invoice/invoice.feature.js";
import { reconcileMemberships } from "@/modules/membership/services/membership-reconciliation.service.js";
import { processMembershipNotificationOutbox } from "@/modules/membership/services/membership-notification.service.js";
import { sendOutNotificationsAfterPayment } from "@/modules/order/controllers/order.notification.controller.js";
import {
  enqueueUpcomingTenantTrialEndingEmails,
  processTenantBillingEmailOutbox,
} from "@/modules/tenant-subscription/services/tenant-subscription.email.service.js";
import { reconcileExpiredTenantTrials } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import { processWaitlistEmailOutbox } from "@/modules/waitlist/waitlist.email.service.js";
import { processVoucherDeliveryOutbox } from "@/modules/coupon/voucher-delivery.service.js";
import { reconcilePaidVoucherPurchases } from "@/modules/coupon/voucher-purchase-reconciliation.service.js";
import { processVoucherManagementRefunds } from "@/modules/coupon/voucher-management-refund.service.js";
import { processBookingPaymentRefunds } from "@/modules/booking/services/booking-payment-refund.service.js";
import { reconcileVoucherCheckoutSessions } from "@/modules/checkout/services/checkout.voucher-session.service.js";
import { reconcileCourseWaitlists } from "@/modules/waitlist/waitlist.reconciliation.service.js";
import { assertWaitlistTokenConfiguration } from "@/modules/waitlist/waitlist.policy.js";
import { ensureProductLocationNameIndex } from "@/modules/product/product-location-name-index.js";
import { ensureOpenStudioLocationIndex } from "@/modules/product/open-studio-location-index.js";

const app = createApp();

const PORT = env.PORT;
const NODE_ENV = env.NODE_ENV;

/*
|--------------------------------------------------------------------------
| Background jobs
|--------------------------------------------------------------------------
*/

const runSafely = async (
  name: string,
  task: () => unknown | Promise<unknown>,
): Promise<void> => {
  try {
    await task();
  } catch (error) {
    logger.error(
      {
        err: error,
        cron: name,
      },
      "Cron job failed.",
    );
  }
};

export const registerCronJobs = (
  supervisor = new CronSupervisor(),
): CronSupervisor => {
  supervisor.schedule("sendOutAccessCodes", "* * * * *", sendOutAccessCodes);
  supervisor.schedule(
    "processTenantBillingEmailOutbox",
    "* * * * *",
    processTenantBillingEmailOutbox,
  );
  supervisor.schedule(
    "processPendingCommunicationDeliveries",
    "* * * * *",
    processPendingCommunicationDeliveries,
  );
  supervisor.schedule(
    "processMembershipNotificationOutbox",
    "* * * * *",
    processMembershipNotificationOutbox,
  );
  supervisor.schedule(
    "processWaitlistEmailOutbox",
    "* * * * *",
    processWaitlistEmailOutbox,
  );
  supervisor.schedule("processVoucherDeliveryOutbox", "* * * * *", () =>
    processVoucherDeliveryOutbox(),
  );
  supervisor.schedule("reconcilePaidVoucherPurchases", "* * * * *", () =>
    reconcilePaidVoucherPurchases(),
  );
  supervisor.schedule("processVoucherManagementRefunds", "* * * * *", () =>
    processVoucherManagementRefunds(),
  );
  supervisor.schedule("processBookingPaymentRefunds", "* * * * *", () =>
    processBookingPaymentRefunds(),
  );
  supervisor.schedule("reconcileVoucherCheckoutSessions", "* * * * *", () =>
    reconcileVoucherCheckoutSessions(),
  );
  supervisor.schedule(
    "reconcileCourseWaitlists",
    "* * * * *",
    reconcileCourseWaitlists,
  );
  supervisor.schedule(
    "removeExpiredTempBookings",
    "*/2 * * * *",
    removeExpiredTempBookingsJob,
  );
  // Offset to the odd minutes so this doesn't stack on the same tick as
  // removeExpiredTempBookings above.
  supervisor.schedule(
    "sendOutNotificationsAfterPayment",
    "1-59/2 * * * *",
    sendOutNotificationsAfterPayment,
  );
  if (isNativeInvoicingEnabled()) {
    supervisor.schedule("reconcilePaidOrderInvoices", "*/10 * * * *", () =>
      reconcilePaidOrderInvoices(),
    );
  }
  // Offset by 5 minutes so this lands away from reconcilePaidOrderInvoices
  // and the other jobs anchored to top-of-hour marks (:00/:10/:30).
  supervisor.schedule(
    "reconcileMemberships",
    "5-59/10 * * * *",
    reconcileMemberships,
  );
  // Offset by 2 minutes so this doesn't land on the same tick as the
  // */10 and */15 jobs, which all share the :00/:10/:20/:30 marks.
  supervisor.schedule(
    "processPendingKnowledgeEmbeddings",
    "2-59/5 * * * *",
    () => processPendingKnowledgeEmbeddings(),
  );
  supervisor.schedule("generateDueAiBriefings", "*/15 * * * *", () =>
    generateDueAiBriefings(),
  );
  // Offset by 7 minutes so this doesn't stack on the same tick as
  // generateDueAiBriefings above.
  supervisor.schedule("reconcileAiUsageReservations", "7-59/15 * * * *", () =>
    reconcileAiUsageReservations(),
  );
  supervisor.schedule(
    "markBookingsAsDelivered",
    "0 * * * *",
    markBookingsAsDelivered,
  );
  // The four hourly jobs below are spread across the first ten minutes of
  // each hour instead of all firing on the same :00 tick as each other and
  // as every */5, */10 and */15 job above.
  supervisor.schedule(
    "sendUpcomingBookingReminders",
    "3 * * * *",
    sendUpcomingBookingReminders,
  );
  supervisor.schedule(
    "reconcileExpiredTenantTrials",
    "6 * * * *",
    reconcileExpiredTenantTrials,
  );
  supervisor.schedule(
    "enqueueUpcomingTenantTrialEndingEmails",
    "9 * * * *",
    enqueueUpcomingTenantTrialEndingEmails,
  );
  supervisor.schedule(
    "enforceAllCommunicationRetention",
    "30 2 * * *",
    enforceAllCommunicationRetention,
  );

  logger.info("Cron jobs registered.");
  return supervisor;
};

/*
|--------------------------------------------------------------------------
| Server startup and shutdown
|--------------------------------------------------------------------------
*/

const startServer = async (): Promise<void> => {
  let cronSupervisor: CronSupervisor | null = null;
  let server: ReturnType<typeof app.listen> | null = null;

  try {
    markRuntimeStarting();
    // Validate before accepting traffic. JWT rotation must never invalidate
    // stable waitlist management links, so this uses a dedicated secret.
    assertWaitlistTokenConfiguration();
    await connectDB();
    await ensureOpenStudioLocationIndex();
    const productNameIndexes = await ensureProductLocationNameIndex();
    if (productNameIndexes.removedLegacyIndexes.length) {
      logger.info(
        productNameIndexes,
        "Product names are now unique per location.",
      );
    }
    const knowledgeTextIndexes = await ensureKnowledgeTextIndex();
    if (knowledgeTextIndexes.removedLegacyIndexes.length) {
      logger.info(
        knowledgeTextIndexes,
        "Knowledge Hub text index is now locale-neutral.",
      );
    }

    // Best-effort cleanup only (runSafely already swallows and logs its
    // errors) and also re-run every 15 minutes by the
    // reconcileAiUsageReservations cron job below, so it must not delay
    // readiness/traffic cutover on deploy. Fire it in the background instead
    // of blocking startup on it.
    void runSafely("reconcileAiUsageReservationsAtStartup", () =>
      reconcileAiUsageReservations(),
    );

    cronSupervisor = new CronSupervisor();
    registerCronJobs(cronSupervisor);

    server = app.listen(PORT);
    await waitForHttpServerListening(server);
    markRuntimeReady();
    logger.info(
      {
        port: PORT,
        env: NODE_ENV,
      },
      "Server started.",
    );

    const shutdown = createGracefulShutdown({
      markNotReady: markRuntimeShuttingDown,
      stopSchedulers: () => cronSupervisor.stop(),
      drainSteps: [
        { name: "http-server", run: () => closeHttpServer(server) },
        { name: "cron-jobs", run: () => cronSupervisor.drain() },
      ],
      forceAfterDrainTimeout: () => server.closeAllConnections?.(),
      cleanupSteps: [
        {
          name: "communication-email-queue",
          run: () => communicationEmailQueue.close(),
        },
        {
          name: "notification-queue",
          run: () => notificationQueue.close(),
        },
        {
          name: "data-import-queue",
          run: () => dataImportQueue.close(),
        },
        { name: "tenant-email-transporters", run: clearEmailServiceCache },
        { name: "default-email-transporter", run: closeEmailTransporter },
        { name: "redis", run: closeRedisConnection },
        { name: "mongodb", run: closeDatabaseConnection },
      ],
      drainTimeoutMs: Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || 30_000),
      cleanupTimeoutMs: Number(
        process.env.SHUTDOWN_CLEANUP_TIMEOUT_MS || 20_000,
      ),
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
          logger.fatal({ err: error, signal }, "Graceful shutdown failed.");
          process.exit(1);
        });
    };

    process.once("SIGTERM", handleSignal);
    process.once("SIGINT", handleSignal);
  } catch (error) {
    logger.fatal({ err: error }, "Application startup failed.");

    cronSupervisor?.stop();
    server?.closeAllConnections?.();

    await Promise.allSettled([
      ...(server ? [closeHttpServer(server)] : []),
      ...(cronSupervisor ? [cronSupervisor.drain()] : []),
      communicationEmailQueue.close(),
      dataImportQueue.close(),
      notificationQueue.close(),
      closeRedisConnection(),
      closeDatabaseConnection(),
    ]);
    clearEmailServiceCache();
    closeEmailTransporter();
    process.exit(1);
  }
};

void startServer();

export default app;
