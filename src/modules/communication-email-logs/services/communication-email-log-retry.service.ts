import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import { enqueueCommunicationEmail } from "@/infrastructure/queues/communication-email.queue.js";
import {
  CommunicationConsentModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import { recordCommunicationAudit } from "@/modules/communications/services/audit.service.js";
import { isCommunicationAllowed } from "@/modules/communications/services/consent.service.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import CommunicationEmailLogModel from "../communication-email-log.model.js";
import {
  buildCommunicationEmailLogScope,
  communicationEmailLogRepository,
} from "../communication-email-log.repository.js";
import {
  decorateCommunicationEmailLog,
  getCommunicationEmailRetryBlock,
  getCommunicationEmailReason,
  knownUnsentEmailLogFilter,
  type CommunicationEmailReason,
} from "../communication-email-log-retry.js";

const idOf = (value: any): string => String(value?._id || value || "");

/** Batch current recipient policy for history; the worker checks it again before sending. */
export const decorateCommunicationEmailLogs = async (
  tenantId: string,
  logs: Array<Record<string, any>>,
) => {
  const candidates = logs.filter(
    (log) => !getCommunicationEmailRetryBlock(log),
  );
  const emails = [...new Set(candidates.map((log) => log.recipientEmail))];
  const users = [
    ...new Set(
      candidates
        .map((log) => idOf(log.user))
        .filter((id) => mongoose.isValidObjectId(id)),
    ),
  ];
  const [suppressions, consents] = await Promise.all([
    emails.length
      ? CommunicationSuppressionModel.find({
          tenantId,
          channel: "email",
          identity: { $in: emails },
          active: true,
        })
          .select("identity reason")
          .lean()
      : [],
    users.length
      ? CommunicationConsentModel.find({
          tenantId,
          channel: "email",
          purpose: "transactional",
          customerId: { $in: users },
        })
          .select("customerId status expiresAt")
          .lean()
      : [],
  ]);
  const suppressionByEmail = new Map(
    suppressions.map((entry: any) => [entry.identity, entry]),
  );
  const consentByUser = new Map(
    consents.map((entry: any) => [idOf(entry.customerId), entry]),
  );
  return logs.map((log) => {
    const suppression = suppressionByEmail.get(log.recipientEmail);
    const policy = isCommunicationAllowed({
      channel: "email",
      purpose: "transactional",
      consent: consentByUser.get(idOf(log.user)),
      suppressed: Boolean(suppression),
    });
    const block = policy.allowed
      ? null
      : ((suppression &&
        ["hard_bounce", "spam_complaint"].includes(suppression.reason)
          ? suppression.reason
          : policy.reason) as CommunicationEmailReason | null);
    return decorateCommunicationEmailLog(log, block);
  });
};

export const retryCommunicationEmailLog = async ({
  tenantId,
  logId,
  actorId,
  expectedManualRetryCount,
  allowedLocationIds = null,
  ipAddress = "",
  userAgent = "",
}: {
  tenantId: string;
  logId: string;
  actorId: string;
  expectedManualRetryCount: number;
  allowedLocationIds?: readonly string[] | null;
  ipAddress?: string;
  userAgent?: string;
}) => {
  const scope = {
    _id: new mongoose.Types.ObjectId(logId),
    ...buildCommunicationEmailLogScope(tenantId, allowedLocationIds),
  };
  const original = await CommunicationEmailLogModel.findOne(scope).exec();
  if (!original)
    notFound({
      code: "COMMUNICATION_EMAIL_LOG_NOT_FOUND",
      message: "Email history entry not found.",
    });
  if (Number(original.manualRetryCount || 0) !== expectedManualRetryCount) {
    conflict({
      code: "COMMUNICATION_EMAIL_RETRY_STALE",
      message:
        "The email history entry changed. Refresh it before trying again.",
    });
  }
  const [eligibility] = await decorateCommunicationEmailLogs(tenantId, [
    original,
  ]);
  if (!eligibility.canRetry)
    conflict({
      code: "COMMUNICATION_EMAIL_RETRY_BLOCKED",
      message: "This email cannot be sent again.",
      details: { reason: eligibility.retryBlockedReason },
    });

  const session = await mongoose.startSession();
  let retried: typeof original;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      retried = await CommunicationEmailLogModel.findOneAndUpdate(
        {
          ...scope,
          ...knownUnsentEmailLogFilter(),
          status: original.status,
          updatedAt: original.updatedAt,
          recipientEmail: original.recipientEmail,
          subject: original.subject,
          body: original.body,
          htmlContent: original.htmlContent,
          $expr: {
            $eq: [
              { $ifNull: ["$manualRetryCount", 0] },
              expectedManualRetryCount,
            ],
          },
        },
        {
          $set: {
            status: "scheduled",
            retryable: true,
            scheduledFor: now,
            failedAt: null,
            queuedAt: null,
            canceledAt: null,
            cancelReason: "",
            errorMessage: "",
            queueRecoveryAttempts: 0,
            nextQueueRecoveryAt: null,
            retryCycleStartAttempt: Number(original.attempts || 0),
            lastManualRetryAt: now,
            lastManualRetryBy: new mongoose.Types.ObjectId(actorId),
          },
          $inc: { manualRetryCount: 1 },
        },
        { session, returnDocument: "after" },
      ).exec();
      if (!retried)
        conflict({
          code: "COMMUNICATION_EMAIL_RETRY_STALE",
          message:
            "The email history entry changed. Refresh it before trying again.",
        });
      await recordCommunicationAudit({
        tenantId,
        actorId,
        action: "email_log.retry",
        resourceType: "communication-email-log",
        resourceId: logId,
        locationId: original.location || null,
        ipAddress,
        userAgent,
        summary: "Requested another delivery attempt for a known-unsent email.",
        before: {
          status: original.status,
          reasonCode: getCommunicationEmailReason(original),
          attempts: original.attempts,
          manualRetryCount: expectedManualRetryCount,
        },
        after: {
          status: "scheduled",
          manualRetryCount: expectedManualRetryCount + 1,
        },
        session,
      });
    });
  } finally {
    await session.endSession();
  }

  let queued = false;
  let queueOutcomeUnknown = false;
  try {
    const result = await enqueueCommunicationEmail(
      {
        tenantId,
        emailLogId: logId,
        ...(retried.automation
          ? { automationId: idOf(retried.automation) }
          : {}),
        ...(retried.user ? { userId: idOf(retried.user) } : {}),
        ...(retried.relatedEntityId
          ? { relatedEntityId: idOf(retried.relatedEntityId) }
          : {}),
      },
      retried.deduplicationKey,
      { allowCompletedRetry: true },
    );
    queued = result.queueAccepted;
    if (queued)
      await communicationEmailLogRepository.markQueued(tenantId, logId);
    else {
      queueOutcomeUnknown = true;
      await communicationEmailLogRepository.markQueueStateAmbiguous(
        tenantId,
        logId,
        result.state,
      );
    }
  } catch (error) {
    // Commit the outbox and audit first. Recovery can dispatch it after a Redis outage.
    logger.warn(
      { err: error, tenantId, emailLogId: logId },
      "Manual email retry persisted; background queue recovery will dispatch it.",
    );
  }
  if (queueOutcomeUnknown)
    conflict({
      code: "COMMUNICATION_EMAIL_RETRY_BLOCKED",
      message: "The delivery state requires review before another attempt.",
      details: { reason: "delivery_outcome_unknown" },
    });
  const current = await CommunicationEmailLogModel.findOne(scope).exec();
  const [log] = await decorateCommunicationEmailLogs(tenantId, [
    current || retried,
  ]);
  return { log, queued };
};
