import mongoose from "mongoose";

import {
  EMAIL_REGEX,
  isBuiltInLifecycleEmailLog,
  isRetryableCommunicationEmailContract,
} from "./communication-email-log.constants.js";

export type CommunicationEmailReason =
  | "status_not_retryable"
  | "delivery_in_progress"
  | "delivery_outcome_unknown"
  | "already_sent"
  | "recipient_suppressed"
  | "consent_revoked"
  | "consent_expired"
  | "marketing_opt_in_required"
  | "consent_required"
  | "content_unavailable"
  | "invalid_delivery_contract"
  | "source_changed"
  | "source_missing"
  | "recipient_ineligible"
  | "automation_inactive"
  | "sender_not_ready"
  | "workspace_disabled"
  | "monthly_allowance_exhausted"
  | "unsupported_email_type"
  | "delivery_failed"
  | "not_sent"
  | "hard_bounce"
  | "spam_complaint";

export type EmailLogRetryMetadata = {
  canRetry: boolean;
  retryBlockedReason: CommunicationEmailReason | null;
  reasonCode: CommunicationEmailReason | null;
};

const idOf = (value: any): string => String(value?._id || value || "");
const validId = (value: unknown): boolean =>
  mongoose.isValidObjectId(idOf(value));
const retryableStatuses = new Set(["failed", "canceled", "suppressed"]);
const policyReasons = new Set([
  "recipient_suppressed",
  "consent_revoked",
  "consent_expired",
  "marketing_opt_in_required",
  "consent_required",
  "hard_bounce",
  "spam_complaint",
]);

/** The same fences are checked again by the atomic state transition. */
export const knownUnsentEmailLogFilter = () => ({
  providerAttemptStartedAt: null,
  providerMessageId: { $in: ["", null] },
  providerLastEvent: null,
  sentAt: null,
  deliveredAt: null,
  bouncedAt: null,
  complainedAt: null,
  manualReviewRequiredAt: null,
  processingClaimToken: { $in: ["", null] },
  processingJobId: { $in: ["", null] },
  processingStartedAt: null,
  processingLeaseExpiresAt: null,
  queueRecoveryClaimToken: { $in: ["", null] },
  queueRecoveryLeaseExpiresAt: null,
});

export const getCommunicationEmailReason = (
  log: Record<string, any>,
): CommunicationEmailReason | null => {
  const reason = String(log.cancelReason || log.errorMessage || "").trim();
  if (policyReasons.has(reason)) return reason as CommunicationEmailReason;
  if (log.status === "ambiguous" || log.manualReviewRequiredAt)
    return "delivery_outcome_unknown";
  if (log.status === "complained") return "spam_complaint";
  if (/allowance exhausted/i.test(reason)) return "monthly_allowance_exhausted";
  if (/sender.*(inactive|unverified|provisioned|configuration)/i.test(reason))
    return "sender_not_ready";
  if (/workspace.*(disabled|not active)/i.test(reason))
    return "workspace_disabled";
  if (/automation.*(inactive|deactivated|reactivated|missing)/i.test(reason))
    return "automation_inactive";
  if (/snapshot.*(incomplete|missing)|redacted/i.test(reason))
    return "content_unavailable";
  if (/invalid.*contract/i.test(reason)) return "invalid_delivery_contract";
  if (
    /source.*(missing|no longer exists)|registration.*date.*invalid/i.test(
      reason,
    )
  )
    return "source_missing";
  if (/recipient.*(eligible|no longer|changed)|contact changed/i.test(reason))
    return "recipient_ineligible";
  if (
    /booking|registration source|registered before/i.test(
      reason,
    )
  )
    return "source_changed";
  if (["failed", "bounced"].includes(log.status)) return "delivery_failed";
  return ["canceled", "suppressed"].includes(log.status) ? "not_sent" : null;
};

export const getCommunicationEmailRetryBlock = (
  log: Record<string, any>,
): CommunicationEmailReason | null => {
  if (
    ["sent", "delivered", "bounced", "complained"].includes(log.status) ||
    log.sentAt ||
    log.deliveredAt ||
    log.bouncedAt ||
    log.complainedAt ||
    log.providerMessageId ||
    log.providerLastEvent
  ) {
    return "already_sent";
  }
  if (
    log.status === "ambiguous" ||
    log.providerAttemptStartedAt ||
    log.manualReviewRequiredAt
  )
    return "delivery_outcome_unknown";
  if (
    ["pending", "scheduled", "queued", "sending"].includes(log.status) ||
    log.processingClaimToken ||
    log.processingJobId ||
    log.processingStartedAt ||
    log.processingLeaseExpiresAt ||
    log.queueRecoveryClaimToken ||
    log.queueRecoveryLeaseExpiresAt
  )
    return "delivery_in_progress";
  if (!retryableStatuses.has(log.status)) return "status_not_retryable";
  if (log.status === "failed" && !log.failedAt)
    return "delivery_outcome_unknown";
  if (
    !EMAIL_REGEX.test(String(log.recipientEmail || "")) ||
    /@retention\.invalid$/i.test(log.recipientEmail || "") ||
    !String(log.subject || "").trim() ||
    /\[redacted by retention policy\]/i.test(log.subject || "") ||
    !String(log.body || log.htmlContent || "").trim()
  )
    return "content_unavailable";
  if (!isRetryableCommunicationEmailContract(log))
    return "unsupported_email_type";
  if (Array.isArray(log.attachments) && log.attachments.length)
    return "unsupported_email_type";
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(String(log.deduplicationKey || "")) ||
    !Number.isSafeInteger(Number(log.attempts || 0)) ||
    Number(log.attempts || 0) < 0
  )
    return "invalid_delivery_contract";
  if (isBuiltInLifecycleEmailLog(log)) {
    if (
      !validId(log.relatedEntityId) ||
      !validId(log.location) ||
      log.appliesToAllLocations ||
      (log.emailType === "firingReady"
        ? log.relatedEntityType !== "firing" || !validId(log.sourceFiringItemId)
        : log.relatedEntityType !== "booking" ||
          !validId(log.user) ||
          log.contentFormat !== "plain")
    )
      return "invalid_delivery_contract";
  } else if (!validId(log.automation)) {
    return "invalid_delivery_contract";
  }
  if (log.user && !validId(log.user)) return "invalid_delivery_contract";
  const sourceType = (
    {
      beforeBooking: "booking",
      afterBookingCreated: "booking",
      afterBooking: "booking",
      beforePurchase: "booking",
      afterPurchase: "booking",
      afterRegistration: "user",
    } as Record<string, string>
  )[log.emailType];
  if (
    sourceType &&
    (log.relatedEntityType !== sourceType ||
      !validId(log.relatedEntityId) ||
      !validId(log.user))
  )
    return "invalid_delivery_contract";
  return null;
};

export const decorateCommunicationEmailLog = (
  log: Record<string, any>,
  policyBlock: CommunicationEmailReason | null = null,
): Record<string, any> & EmailLogRetryMetadata => {
  const value = typeof log.toObject === "function" ? log.toObject() : log;
  const retryBlockedReason =
    getCommunicationEmailRetryBlock(value) || policyBlock;
  const historicalReason = getCommunicationEmailReason(value);
  return {
    ...value,
    manualRetryCount: Number(value.manualRetryCount || 0),
    canRetry: retryBlockedReason === null,
    retryBlockedReason,
    reasonCode:
      historicalReason === "recipient_suppressed" &&
      policyBlock &&
      ["hard_bounce", "spam_complaint"].includes(policyBlock)
        ? policyBlock
        : historicalReason,
  };
};
