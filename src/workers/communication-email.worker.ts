import "dotenv/config";

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import mongoose from "mongoose";
import { Job, Worker } from "bullmq";

import { logger } from "@/config/logger.js";
import connectDB, {
  closeDatabaseConnection,
} from "@/infrastructure/database/connect-db.js";
import { sendManagedTenantEmail } from "@/infrastructure/email/managed-email.service.js";
import { createGracefulShutdown } from "@/infrastructure/lifecycle/graceful-shutdown.js";
import {
  communicationEmailQueue,
  communicationEmailQueueName,
  enqueueCommunicationEmail,
  type CommunicationEmailJobData,
} from "@/infrastructure/queues/communication-email.queue.js";
import { bullMqWorkerConnection, bullMqPrefix } from "@/infrastructure/redis/redis.js";
import BookingModel from "@/modules/booking/booking.model.js";
import CommunicationAutomationModel from "@/modules/communication-automations/communication-automation.model.js";
import { buildCommunicationEmailVariables } from "@/modules/communication-automations/services/communication-email-variables.service.js";
import { getCommunicationEmailSourceInvalidReason } from "@/modules/communication-automations/services/communication-email-source-validation.service.js";
import {
  isWithinAutomationQuietHours,
  moveAfterAutomationQuietHours,
} from "@/modules/communication-automations/services/communication-automation-schedule.service.js";
import CommunicationEmailLogModel from "@/modules/communication-email-logs/communication-email-log.model.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import {
  isBookingLifecycleEmailLog,
  isBuiltInLifecycleEmailLog,
  getCommunicationEmailAttemptLimit,
} from "@/modules/communication-email-logs/communication-email-log.constants.js";
import { processBookingLifecycleEmail } from "./booking-lifecycle-email.processor.js";
import {
  consumeCommunicationEmailAllowance,
  reconcileCommunicationEmailAllowanceReservations,
  releaseCommunicationEmailAllowance,
  reserveCommunicationEmailAllowance,
} from "@/modules/communication-email-logs/communication-email-allowance.service.js";
import {
  CommunicationConsentModel,
  CommunicationSettingsModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import { isCommunicationAllowed } from "@/modules/communications/services/consent.service.js";
import { renderEmailContent } from "@/modules/email-template/email-template.rendering.js";
import OrderModel from "@/modules/order/order.model.js";
import LocationModel from "@/modules/location/location.model.js";
import ProductModel from "@/modules/product/product.model.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import UserModel from "@/modules/user/user.model.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { registerWorkspaceNotificationPublisher } from "@/modules/workspace-notifications/workspace-notification.bootstrap.js";
import { startWorkerOperationalTelemetry } from "@/infrastructure/queues/worker-operational-telemetry.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";

const normalizeEmail = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase();

const getSenderId = (sender: unknown): string => {
  if (sender && typeof sender === "object" && "_id" in sender) {
    return String((sender as { _id: unknown })._id);
  }
  return String(sender || "");
};

const emitTerminalCommunicationEmailFailure = ({
  tenantId,
  emailLogId,
}: {
  tenantId: string;
  emailLogId: string;
}): void => {
  if (!tenantId || !emailLogId) return;

  emitWorkspaceNotificationEvent({
    tenantId,
    requiredPermission: WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW,
    eventType: "communication.failed",
    severity: "critical",
    title: {
      en: "Email automation needs attention",
      cs: "E-mailová automatizace vyžaduje pozornost",
    },
    message: {
      en: "An automated email could not be delivered after all recovery attempts.",
      cs: "Automatický e-mail se nepodařilo doručit ani po všech pokusech o obnovení.",
    },
    actionUrl: "/app/communications?section=history",
    sourceType: "communication-email-log",
    sourceId: emailLogId,
    deduplicationKey: `communication-email:${emailLogId}:terminal-failure`,
    groupKey: "communication.failed",
  });
};

const cancel = async (
  tenantId: string,
  emailLogId: string,
  reason: string,
  status: "canceled" | "suppressed",
  claimToken: string,
) => {
  const canceled = await communicationEmailLogRepository.markCanceled(
    tenantId,
    emailLogId,
    reason,
    status,
    claimToken,
  );
  return canceled
    ? { skipped: true, reason }
    : { skipped: true, reason: "claim_lost_before_cancel" };
};

const loadRelatedEntity = async (
  tenantId: string,
  log: Record<string, any>,
) => {
  const id = String(log.relatedEntityId || "");
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  if (log.relatedEntityType === "booking") {
    // Migration provenance is select:false. Apply suppression in the query so
    // queued deliveries cannot bypass it through the public booking projection.
    return BookingModel.findOne({
      _id: id,
      tenant: tenantId,
      "atelierKleiMigration.suppressHistoricalNotifications": { $ne: true },
    })
      .populate({
        path: "location",
        model: LocationModel,
        select: "name booking.timezone address contact.email contact.phone",
      })
      .populate({
        path: "bookingProduct",
        model: ProductModel,
        select: "name price",
      })
      .populate({
        path: "orders",
        model: OrderModel,
        match: { tenant: tenantId },
        select:
          "_id tenant createdBy isPaid paidAt grossAmountMinor expectedAmountMinor paidAmountMinor currency",
      })
      .lean();
  }
  if (log.relatedEntityType === "user") {
    return UserModel.findOne({ _id: id, tenant: tenantId }).lean();
  }
  return null;
};

const reconcileCommunicationEmailAllowanceIfConnected = async (
  options: Parameters<
    typeof reconcileCommunicationEmailAllowanceReservations
  >[0] = {},
): Promise<void> => {
  if (mongoose.connection.readyState !== 1) return;

  try {
    await reconcileCommunicationEmailAllowanceReservations(options);
  } catch (error) {
    logger.error(
      { err: error },
      "Communication email allowance reconciliation failed.",
    );
  }
};

export const recoverStaleCommunicationEmailJobs = async ({
  now = new Date(),
  limit = Number(process.env.COMMUNICATION_EMAIL_RECOVERY_BATCH_SIZE || 200),
}: {
  now?: Date;
  limit?: number;
} = {}) => {
  const recovered = await communicationEmailLogRepository.recoverStaleSending({
    now,
    limit,
  });
  const candidates =
    await communicationEmailLogRepository.listQueueReconciliationCandidates({
      now,
      limit,
    });
  const maxDeliveryAttempts = Math.max(
    1,
    Number(process.env.COMMUNICATION_EMAIL_MAX_DELIVERY_ATTEMPTS || 6),
  );
  const maxQueueRecoveryAttempts = Math.max(
    1,
    Number(process.env.COMMUNICATION_EMAIL_MAX_QUEUE_RECOVERY_ATTEMPTS || 5),
  );
  let queueAccepted = 0;
  let queueAmbiguous = 0;
  let deferred = 0;
  for (const candidate of candidates) {
    const tenantId = String(candidate.tenant);
    const emailLogId = String(candidate._id);
    const reconciliationClaimToken = randomUUID();
    const claimed =
      await communicationEmailLogRepository.claimQueueReconciliation({
        tenantId,
        logId: emailLogId,
        claimToken: reconciliationClaimToken,
        now,
      });
    if (!claimed) continue;
    const log =
      typeof claimed.toObject === "function" ? claimed.toObject() : claimed;
    if (
      Number(log.attempts || 0) >=
      getCommunicationEmailAttemptLimit(log, maxDeliveryAttempts)
    ) {
      const marked = Number(
        await communicationEmailLogRepository.markReconciliationAmbiguous(
          tenantId,
          emailLogId,
          reconciliationClaimToken,
          "delivery_attempts_exhausted",
        ),
      );
      queueAmbiguous += marked;
      if (marked) {
        emitTerminalCommunicationEmailFailure({ tenantId, emailLogId });
      }
      continue;
    }
    if (Number(log.queueRecoveryAttempts || 0) >= maxQueueRecoveryAttempts) {
      const marked = Number(
        await communicationEmailLogRepository.markReconciliationAmbiguous(
          tenantId,
          emailLogId,
          reconciliationClaimToken,
          "queue_recovery_exhausted",
        ),
      );
      queueAmbiguous += marked;
      if (marked) {
        emitTerminalCommunicationEmailFailure({ tenantId, emailLogId });
      }
      continue;
    }
    try {
      if (!log.automation && !isBuiltInLifecycleEmailLog(log)) {
        const marked = Number(
          await communicationEmailLogRepository.markReconciliationAmbiguous(
            tenantId,
            emailLogId,
            reconciliationClaimToken,
            "invalid_delivery_contract",
          ),
        );
        queueAmbiguous += marked;
        if (marked)
          emitTerminalCommunicationEmailFailure({ tenantId, emailLogId });
        continue;
      }
      const result = await enqueueCommunicationEmail(
        {
          tenantId,
          emailLogId,
          ...(log.automation ? { automationId: String(log.automation) } : {}),
          ...(log.user ? { userId: String(log.user) } : {}),
          ...(log.relatedEntityId
            ? { relatedEntityId: String(log.relatedEntityId) }
            : {}),
        },
        String(log.deduplicationKey),
        { allowCompletedRetry: String(log.status) !== "failed" },
      );
      if (result.queueAccepted) {
        queueAccepted += Number(
          await communicationEmailLogRepository.markReconciledQueued(
            tenantId,
            emailLogId,
            reconciliationClaimToken,
            now,
          ),
        );
      } else {
        queueAmbiguous += Number(
          await communicationEmailLogRepository.markReconciliationAmbiguous(
            tenantId,
            emailLogId,
            reconciliationClaimToken,
            String(result.state),
          ),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Queue reconciliation failed.";
      if (
        Number(log.queueRecoveryAttempts || 0) + 1 >=
        maxQueueRecoveryAttempts
      ) {
        const marked = Number(
          await communicationEmailLogRepository.markReconciliationAmbiguous(
            tenantId,
            emailLogId,
            reconciliationClaimToken,
            "queue_recovery_failed",
          ),
        );
        queueAmbiguous += marked;
        if (marked) {
          emitTerminalCommunicationEmailFailure({ tenantId, emailLogId });
        }
      } else {
        deferred += Number(
          await communicationEmailLogRepository.deferQueueReconciliation(
            tenantId,
            emailLogId,
            reconciliationClaimToken,
            message,
            now,
          ),
        );
      }
    }
  }
  await reconcileCommunicationEmailAllowanceIfConnected({ limit });
  return {
    requeued: recovered.requeued.length,
    queueAccepted,
    deferred,
    ambiguous: recovered.ambiguous + queueAmbiguous,
  };
};

export const validateCommunicationEmailSource = async ({
  tenantId,
  emailLogId,
  automation,
  log,
  entity,
  recipientIsEligible = true,
  now = new Date(),
  claimToken,
}: {
  tenantId: string;
  emailLogId: string;
  automation: Record<string, any>;
  log: Record<string, any>;
  entity: Record<string, any> | null;
  recipientIsEligible?: boolean;
  now?: Date;
  claimToken: string;
}) => {
  const reason = getCommunicationEmailSourceInvalidReason({
    automation,
    log,
    entity,
    recipientIsEligible,
    now,
  });
  return reason
    ? cancel(tenantId, emailLogId, reason, "canceled", claimToken)
    : null;
};

const processCommunicationEmailJobAttempt = async (
  job: Job<CommunicationEmailJobData>,
) => {
  const { tenantId, emailLogId, automationId, userId } = job.data;
  if (!tenantId || !emailLogId) {
    throw new Error("Communication email job is missing required identifiers.");
  }

  const current = await CommunicationEmailLogModel.findOne({
    _id: emailLogId,
    tenant: tenantId,
  }).lean();
  if (!current) throw new Error(`Email log not found: ${emailLogId}`);
  if (current.status === "sent")
    return { skipped: true, reason: "already_sent" };
  if (
    [
      "ambiguous",
      "canceled",
      "suppressed",
      "delivered",
      "bounced",
      "complained",
    ].includes(String(current.status)) ||
    current.retryable === false
  ) {
    return { skipped: true, reason: String(current.status) };
  }

  const claimToken = randomUUID();
  const jobId = String(job.id || emailLogId);
  const log = await communicationEmailLogRepository.claimForSending({
    tenantId,
    logId: emailLogId,
    jobId,
    claimToken,
  });
  if (!log) return { skipped: true, reason: "not_claimable" };

  if (isBookingLifecycleEmailLog(log)) {
    const result = await processBookingLifecycleEmail({
      tenantId,
      emailLogId,
      jobId,
      claimToken,
      log,
    });
    if ("terminalFailure" in result && result.terminalFailure) {
      emitTerminalCommunicationEmailFailure({ tenantId, emailLogId });
    }
    return result;
  }
  if (
    !automationId ||
    String(log.automation || "") !== automationId ||
    log.allowanceClass === "essential_system"
  ) {
    return cancel(
      tenantId,
      emailLogId,
      "Invalid automation delivery contract.",
      "canceled",
      claimToken,
    );
  }

  const tenant = await TenantModel.findOne({
    _id: tenantId,
    status: "active",
    "modules.automations": true,
    "modules.communications": true,
  })
    .select("name settings publicSite modules limits status planVersion")
    .lean();
  if (!tenant) {
    return cancel(
      tenantId,
      emailLogId,
      "Workspace automation delivery is disabled.",
      "canceled",
      claimToken,
    );
  }

  const automation = await CommunicationAutomationModel.findOne({
    _id: automationId,
    tenant: tenantId,
  })
    .populate({
      path: "senderEmail",
      model: RegisteredSenderEmailModel,
      match: { tenant: tenantId, isActive: true },
      select:
        "+tenant +email +displayName +provider +isActive +replyToEmail +replyToVerifiedAt +providerServerId +providerProvisionedAt +providerProvisioningStatus +updatedAt",
    })
    .lean();
  const completedOneTime =
    automation?.scheduleType === "oneTimeEmail" &&
    automation?.automationStatus === "inactive";
  if (!automation || (!automation.isActive && !completedOneTime)) {
    return cancel(
      tenantId,
      emailLogId,
      "Automation is missing or inactive.",
      "canceled",
      claimToken,
    );
  }
  if (automation.purpose === "marketing" || log.purpose === "marketing") {
    return cancel(
      tenantId,
      emailLogId,
      "Marketing automation delivery is disabled until unsubscribe management is enabled.",
      "canceled",
      claimToken,
    );
  }
  const sender = automation.senderEmail as Record<string, any> | null;
  if (
    !sender ||
    sender.isActive !== true ||
    sender.provider !== "postmark_managed" ||
    !sender.replyToEmail ||
    !sender.replyToVerifiedAt ||
    !sender.providerServerId ||
    !sender.providerProvisionedAt ||
    sender.providerProvisioningStatus !== "ready"
  ) {
    return cancel(
      tenantId,
      emailLogId,
      "Managed sender is inactive, unverified, or not provisioned.",
      "canceled",
      claimToken,
    );
  }

  const [settings, user, entity] = await Promise.all([
    CommunicationSettingsModel.findOne({ tenantId })
      .select("quietHours businessHours.timezone")
      .lean(),
    userId && mongoose.Types.ObjectId.isValid(userId)
      ? UserModel.findOne({
          _id: userId,
          tenant: tenantId,
          tenantRole: "customer",
          isAccessGranted: { $ne: false },
        }).lean()
      : null,
    loadRelatedEntity(tenantId, log.toObject()),
  ]);
  const stale = await validateCommunicationEmailSource({
    tenantId,
    emailLogId,
    automation,
    log: log.toObject(),
    entity,
    recipientIsEligible: !log.user || Boolean(user),
    claimToken,
  });
  if (stale) return stale;

  const timezone = String(
    (entity as any)?.location?.booking?.timezone ||
      settings?.businessHours?.timezone ||
      tenant.settings?.timezone ||
      "Europe/Prague",
  );
  const now = new Date();
  if (
    automation.respectQuietHours !== false &&
    isWithinAutomationQuietHours(now, settings?.quietHours, timezone)
  ) {
    const scheduledFor = moveAfterAutomationQuietHours(
      now,
      settings?.quietHours,
      timezone,
    );
    const deferred = await communicationEmailLogRepository.defer(
      tenantId,
      emailLogId,
      scheduledFor,
      "Deferred until quiet hours end.",
      claimToken,
    );
    if (!deferred) {
      return { skipped: true, reason: "claim_lost_before_defer" };
    }
    // Persist a claimable state before creating the delayed job. If the
    // process crashes between these operations, BullMQ retries the original
    // job and can safely claim the scheduled log again.
    await enqueueCommunicationEmail(job.data, String(log.deduplicationKey), {
      delay: Math.max(1_000, scheduledFor.getTime() - now.getTime()),
      jobIdSuffix: `deferred-${scheduledFor.getTime()}`,
    });
    return { deferred: true, scheduledFor };
  }

  const recipientEmail = normalizeEmail(
    log.recipientEmail || (user as any)?.email,
  );
  if (!recipientEmail) {
    return cancel(
      tenantId,
      emailLogId,
      "Recipient email is missing.",
      "canceled",
      claimToken,
    );
  }
  const purpose = log.purpose === "security" ? "security" : "transactional";
  const [suppression, consent] = await Promise.all([
    CommunicationSuppressionModel.exists({
      tenantId,
      channel: "email",
      identity: recipientEmail,
      active: true,
    }),
    user?._id
      ? CommunicationConsentModel.findOne({
          tenantId,
          customerId: user._id,
          channel: "email",
          purpose,
        }).lean()
      : null,
  ]);
  const policy = isCommunicationAllowed({
    channel: "email",
    purpose,
    consent,
    suppressed: Boolean(suppression),
  });
  if (!policy.allowed) {
    return cancel(
      tenantId,
      emailLogId,
      policy.reason,
      "suppressed",
      claimToken,
    );
  }

  const locale = String(log.locale) === "en" ? "en" : "cs";
  const recipient = {
    email: recipientEmail,
    name: String(log.recipientName || ""),
  };
  const rendered = renderEmailContent({
    source: {
      subject: String(log.subject || ""),
      htmlContent: String(log.htmlContent || ""),
      body: String(log.body || ""),
      format: log.contentFormat === "plain" ? "plain" : "html",
      defaultLocale: locale,
    },
    locale,
    variables: buildCommunicationEmailVariables({
      tenant: tenant as any,
      user: user as any,
      entity: entity as any,
      recipient,
      locale,
      timezone,
      sourceOrderId: log.sourceOrderId,
    }),
  });

  const automationStillDeliverable = await CommunicationAutomationModel.exists({
    _id: automationId,
    tenant: tenantId,
    // A deactivate/reactivate cycle must not reuse an older validated cutoff.
    ...(automation.scheduleType === "afterRegistration"
      ? { activatedAt: automation.activatedAt }
      : {}),
    $or: [
      { isActive: true, automationStatus: "active" },
      {
        scheduleType: "oneTimeEmail",
        automationStatus: "inactive",
        lastScheduledFor: { $ne: null },
      },
    ],
  });
  if (!automationStillDeliverable) {
    return cancel(
      tenantId,
      emailLogId,
      "Automation was deactivated or reactivated before delivery.",
      "canceled",
      claimToken,
    );
  }

  const allowance = await reserveCommunicationEmailAllowance({
    tenantId,
    emailLogId,
    idempotencyKey: String(log.deduplicationKey || emailLogId),
    allowanceClass: log.allowanceClass,
    planVersion: Number(tenant.planVersion ?? 1),
  });
  if (allowance.kind === "exhausted") {
    const canceled = await communicationEmailLogRepository.markCanceled(
      tenantId,
      emailLogId,
      "Monthly email allowance exhausted.",
      "canceled",
      claimToken,
    );
    return {
      skipped: true,
      reason: canceled
        ? "monthly_email_allowance_exhausted"
        : "claim_lost_at_email_allowance",
      periodEnd: allowance.periodEnd,
      limit: allowance.limit,
    };
  }
  const allowanceReservationId =
    allowance.kind === "reserved" ? allowance.reservationId : null;

  const providerAttempt =
    await communicationEmailLogRepository.beginProviderAttempt({
      tenantId,
      logId: emailLogId,
      jobId,
      claimToken,
    });
  if (!providerAttempt) {
    await reconcileCommunicationEmailAllowanceIfConnected({
      emailLogIds: [emailLogId],
    });
    return { skipped: true, reason: "claim_lost_before_provider" };
  }

  let delivery: Awaited<ReturnType<typeof sendManagedTenantEmail>>;
  try {
    delivery = await sendManagedTenantEmail({
      tenantId,
      to: recipientEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      senderEmailId: getSenderId(sender),
      emailLogId,
      automationId,
      idempotencyKey: String(log.deduplicationKey),
      headers: {
        "Message-ID": `<${log.deduplicationKey}@notify.shario.io>`,
        "X-Shario-Delivery-Key": String(log.deduplicationKey),
      },
    });
  } catch (error: any) {
    const providerOutcomeKnownNotSent =
      error?.safeToRetry === true || error?.deliveryOutcome === "not_sent";
    if (providerOutcomeKnownNotSent) {
      const failed = await communicationEmailLogRepository.markFailed(
        tenantId,
        emailLogId,
        error instanceof Error ? error.message : "Unknown email sending error.",
        claimToken,
        true,
      );
      if (!failed) {
        await reconcileCommunicationEmailAllowanceIfConnected({
          emailLogIds: [emailLogId],
        });
        return { skipped: true, reason: "claim_lost_after_provider_rejection" };
      }
      if (allowanceReservationId) {
        await releaseCommunicationEmailAllowance(allowanceReservationId);
      }
      throw error;
    }
    if (allowanceReservationId) {
      await consumeCommunicationEmailAllowance(allowanceReservationId);
    }
    const ambiguous = await communicationEmailLogRepository.markAmbiguous(
      tenantId,
      emailLogId,
      `Postmark delivery outcome is unknown: ${
        error instanceof Error ? error.message : "Unknown email sending error."
      } Reconcile with the provider before retrying.`,
      claimToken,
    );
    return {
      ambiguous: true,
      recipientEmail,
      reason: ambiguous
        ? "provider_outcome_unknown"
        : "claim_lost_after_provider_attempt",
    };
  }

  if (allowanceReservationId) {
    await consumeCommunicationEmailAllowance(allowanceReservationId);
  }

  try {
    const recorded = await communicationEmailLogRepository.markSent(
      tenantId,
      emailLogId,
      delivery.providerMessageId,
      delivery.provider,
      claimToken,
    );
    if (!recorded) {
      await communicationEmailLogRepository.markAmbiguous(
        tenantId,
        emailLogId,
        "Postmark accepted the message, but the durable sent transition lost claim ownership. Reconcile with the provider before retrying.",
        claimToken,
      );
      return {
        ambiguous: true,
        recipientEmail,
        reason: "sent_transition_not_recorded",
      };
    }
  } catch (error) {
    try {
      await communicationEmailLogRepository.markAmbiguous(
        tenantId,
        emailLogId,
        "Postmark accepted the message, but recording the sent result failed. Reconcile with the provider before retrying.",
        claimToken,
      );
    } catch (statusError) {
      logger.error(
        { err: statusError, tenantId, emailLogId },
        "Failed to mark an accepted Postmark delivery as ambiguous.",
      );
    }
    logger.error(
      { err: error, tenantId, emailLogId },
      "Postmark accepted a communication email but its sent status could not be recorded.",
    );
    return {
      ambiguous: true,
      recipientEmail,
      reason: "sent_transition_failed",
    };
  }

  return {
    sent: true,
    recipientEmail,
    providerMessageId: delivery.providerMessageId,
  };
};

export const processCommunicationEmailJob = async (
  job: Job<CommunicationEmailJobData>,
) => {
  try {
    return await processCommunicationEmailJobAttempt(job);
  } catch (error) {
    const { tenantId, emailLogId } = job.data || {};
    logger.error(
      { err: error, tenantId, emailLogId, jobId: job.id },
      "Communication email attempt failed before a durable outcome was recorded; its lease will be recovered.",
    );
    throw error;
  }
};

export const createCommunicationEmailWorker = () =>
  new Worker<CommunicationEmailJobData>(
    communicationEmailQueueName,
    processCommunicationEmailJob,
    {
      connection: bullMqWorkerConnection,
      prefix: bullMqPrefix,
      concurrency: Number(
        process.env.COMMUNICATION_EMAIL_WORKER_CONCURRENCY || 5,
      ),
      lockDuration: 120_000,
    },
  );

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
);

export const startCommunicationEmailWorker = async ({
  registerSignalHandlers = true,
}: {
  registerSignalHandlers?: boolean;
} = {}) => {
  await connectDB();
  registerWorkspaceNotificationPublisher();

  const recoveryIntervalMs = Math.max(
    60_000,
    Number(process.env.COMMUNICATION_EMAIL_RECOVERY_INTERVAL_MS || 60_000),
  );
  let recoveryRun: Promise<void> | null = null;
  let shuttingDown = false;

  const runRecovery = (): Promise<void> => {
    if (shuttingDown) {
      return Promise.resolve();
    }

    if (recoveryRun) {
      return recoveryRun;
    }

    recoveryRun = (async () => {
      try {
        const recovered = await recoverStaleCommunicationEmailJobs();
        if (recovered.requeued || recovered.ambiguous) {
          logger.warn(
            recovered,
            "Recovered stale communication email delivery claims.",
          );
        }
      } catch (error) {
        logger.error(
          { err: error },
          "Communication email stale-claim recovery failed.",
        );
      } finally {
        recoveryRun = null;
      }
    })();

    return recoveryRun;
  };

  const worker = createCommunicationEmailWorker();
  const telemetry = startWorkerOperationalTelemetry({
    role: "communication-email",
    queueName: communicationEmailQueueName,
    queue: communicationEmailQueue,
    emit: (sample) => logger.info(sample, "Worker operational sample."),
  });
  const recoveryTimer = setInterval(
    () => void runRecovery(),
    recoveryIntervalMs,
  );
  recoveryTimer.unref();
  worker.on("completed", (job) => {
    telemetry.recordCompleted();
    logger.info(
      { jobId: job.id, queue: communicationEmailQueueName },
      "Communication email job completed.",
    );
  });
  worker.on("failed", (job, error) => {
    telemetry.recordFailedAttempt();
    logger.error(
      { err: error, jobId: job?.id, queue: communicationEmailQueueName },
      "Communication email job failed.",
    );
  });
  worker.on("error", (error) => {
    logger.error({ err: error }, "Communication email worker error.");
  });

  const shutdown = createGracefulShutdown({
    markNotReady: () => {
      shuttingDown = true;
    },
    stopSchedulers: () => {
      telemetry.stop();
      clearInterval(recoveryTimer);
      return worker.pause(true);
    },
    drainSteps: [
      {
        name: "communication-email-recovery",
        run: () => recoveryRun || Promise.resolve(),
      },
      { name: "communication-email-worker", run: () => worker.close() },
    ],
    forceAfterDrainTimeout: () => worker.close(true),
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
          "Communication email worker shutdown failed.",
        );
        process.exit(1);
      });
  };

  if (registerSignalHandlers) {
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  }

  await runRecovery();

  logger.info(
    { queue: communicationEmailQueueName },
    "Communication email worker running.",
  );

  return { worker, shutdown };
};

if (isDirectExecution) {
  void startCommunicationEmailWorker().catch(async (error) => {
    logger.fatal({ err: error }, "Communication email worker startup failed.");
    await Promise.allSettled([
      communicationEmailQueue.close(),
      closeDatabaseConnection(),
    ]);
    process.exit(1);
  });
}
