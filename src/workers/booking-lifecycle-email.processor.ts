import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import { sendManagedTenantEmail } from "@/infrastructure/email/managed-email.service.js";
import BookingModel from "@/modules/booking/booking.model.js";
import { Order } from "@/modules/order/order.model.js";
import { reserveCommunicationEmailAllowance } from "@/modules/communication-email-logs/communication-email-allowance.service.js";
import {
  COMMUNICATION_EMAIL_ALLOWANCE_CLASS,
  COMMUNICATION_EMAIL_TYPE,
  isBookingLifecycleEmailLog,
} from "@/modules/communication-email-logs/communication-email-log.constants.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import type { CommunicationEmailLogDocument } from "@/modules/communication-email-logs/communication-email-log.types.js";
import {
  CommunicationConsentModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import { isCommunicationAllowed } from "@/modules/communications/services/consent.service.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import UserModel from "@/modules/user/user.model.js";
import { getCustomerContactEmail } from "@/modules/user/user.guest-contact.js";

const normalizeEmail = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();
class LifecycleClaimLostError extends Error {}

/** Sends immutable, server-created booking notices through the shared history. */
export const processBookingLifecycleEmail = async ({
  tenantId,
  emailLogId,
  jobId,
  claimToken,
  log,
}: {
  tenantId: string;
  emailLogId: string;
  jobId: string;
  claimToken: string;
  log: CommunicationEmailLogDocument;
}) => {
  const cancel = async (
    reason: string,
    status: "canceled" | "suppressed" = "canceled",
  ) => {
    const recorded = await communicationEmailLogRepository.markCanceled(
      tenantId,
      emailLogId,
      reason,
      status,
      claimToken,
    );
    return {
      skipped: true,
      reason: recorded ? reason : "claim_lost_before_cancel",
    };
  };
  let providerStarted = false;
  let providerAccepted = false;
  const recipientEmail = normalizeEmail(log.recipientEmail);
  const maxAttempts = Math.max(
    1,
    Number(process.env.COMMUNICATION_EMAIL_MAX_DELIVERY_ATTEMPTS || 6),
  );

  try {
    if (!isBookingLifecycleEmailLog(log))
      return cancel("Invalid built-in booking email contract.");
    if (Number(log.attempts || 0) >= maxAttempts) {
      const recorded = await communicationEmailLogRepository.markFailed(
        tenantId,
        emailLogId,
        "Booking email delivery attempts exhausted.",
        claimToken,
        true,
        { retryable: false },
      );
      return {
        terminalFailure: recorded,
        reason: "delivery_attempts_exhausted",
      };
    }
    const userId = String(log.user || "");
    const bookingId = String(log.relatedEntityId || "");
    const sourceOrderId = log.sourceOrderId ? String(log.sourceOrderId) : null;
    if (
      !mongoose.isValidObjectId(userId) ||
      !mongoose.isValidObjectId(bookingId) ||
      log.relatedEntityType !== "booking" ||
      !recipientEmail ||
      log.contentFormat !== "plain" ||
      !log.subject?.trim() ||
      !log.body?.trim()
    ) {
      return cancel("Booking email snapshot is incomplete.");
    }
    if (
      sourceOrderId &&
      (!mongoose.isValidObjectId(sourceOrderId) ||
        log.emailType !== COMMUNICATION_EMAIL_TYPE.BOOKING_CANCELLED)
    ) {
      return cancel("Course cancellation email source is invalid.");
    }
    const [tenant, user, booking] = await Promise.all([
      TenantModel.findOne({ _id: tenantId, status: "active" })
        .select("_id planVersion")
        .lean(),
      UserModel.findOne({ _id: userId, tenant: tenantId })
        .select("email customId isAccessGranted +guestContact")
        .lean(),
      BookingModel.findOne({
        _id: bookingId,
        tenant: tenantId,
        ...(sourceOrderId
          ? { tag: { $in: ["class", "course"] } }
          : { createdBy: userId }),
      })
        .select("_id status start location participants.order")
        .lean(),
    ]);
    if (!tenant) return cancel("Workspace is not active.");
    if (!user || !booking)
      return cancel(
        "Booking recipient no longer belongs to this workspace and booking.",
      );
    if (normalizeEmail(getCustomerContactEmail(user)) !== recipientEmail) {
      return cancel(
        "Booking recipient contact changed after this notice was created.",
      );
    }
    if (
      String(booking.location || "") !== String(log.location || "") ||
      log.appliesToAllLocations
    ) {
      return cancel("Booking email location does not match its source.");
    }
    if (sourceOrderId) {
      const order = await Order.findOne({
        _id: sourceOrderId,
        tenant: tenantId,
        createdBy: userId,
        isPaid: true,
        status: "processed_order",
        "courseBookings.bookingId": bookingId,
      })
        .select("courseCancellations")
        .lean();
      const cancellation = order?.courseCancellations?.find(
        (entry) => String(entry.bookingId) === bookingId,
      );
      if (
        !cancellation ||
        !(cancellation.quantity > 0) ||
        !cancellation.refundedAt ||
        booking.participants?.some(
          (participant) => String(participant.order) === sourceOrderId,
        )
      ) {
        return cancel(
          "Course order no longer has a completed participant cancellation.",
        );
      }
    } else if (log.emailType === COMMUNICATION_EMAIL_TYPE.BOOKING_CANCELLED) {
      if (booking.status !== "cancelled")
        return cancel("Booking is no longer cancelled.");
    } else {
      const sourceStart = new Date(log.sourceScheduledAt || "").getTime();
      const currentStart = new Date(booking.start).getTime();
      if (
        booking.status === "cancelled" ||
        !Number.isFinite(sourceStart) ||
        sourceStart !== currentStart
      ) {
        return cancel("Booking was cancelled or rescheduled again.");
      }
    }
    const [suppressed, consent] = await Promise.all([
      CommunicationSuppressionModel.exists({
        tenantId,
        channel: "email",
        identity: recipientEmail,
        active: true,
      }),
      CommunicationConsentModel.findOne({
        tenantId,
        customerId: userId,
        channel: "email",
        purpose: "transactional",
      }).lean(),
    ]);
    const policy = isCommunicationAllowed({
      channel: "email",
      purpose: "transactional",
      consent,
      suppressed: Boolean(suppressed),
    });
    if (!policy.allowed) return cancel(policy.reason, "suppressed");

    // Essential notices remain available when a tenant's editable automation
    // allowance is exhausted. This class is selected only by the trusted log.
    await reserveCommunicationEmailAllowance({
      tenantId,
      emailLogId,
      idempotencyKey: log.deduplicationKey,
      allowanceClass: COMMUNICATION_EMAIL_ALLOWANCE_CLASS.ESSENTIAL_SYSTEM,
      planVersion: Number(tenant.planVersion ?? 1),
    });
    const delivery = await sendManagedTenantEmail({
      tenantId,
      to: recipientEmail,
      subject: log.subject,
      text: log.body,
      emailLogId,
      idempotencyKey: log.deduplicationKey,
      deliveryId: claimToken,
      headers: {
        "Message-ID": `<${log.deduplicationKey}@notify.shario.io>`,
        "X-Shario-Delivery-Key": log.deduplicationKey,
      },
      beforeSend: async () => {
        const fenced =
          await communicationEmailLogRepository.beginProviderAttempt({
            tenantId,
            logId: emailLogId,
            jobId,
            claimToken,
          });
        if (!fenced)
          throw new LifecycleClaimLostError(
            "Booking email delivery claim expired before provider submission.",
          );
        providerStarted = true;
      },
    });
    providerAccepted = true;
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
        "Postmark accepted the booking notice, but its sent transition lost ownership. Reconcile before retrying.",
        claimToken,
      );
      return { ambiguous: true, reason: "sent_transition_not_recorded" };
    }
    return {
      sent: true,
      recipientEmail,
      providerMessageId: delivery.providerMessageId,
    };
  } catch (error) {
    if (error instanceof LifecycleClaimLostError)
      return { skipped: true, reason: "claim_lost_before_provider" };
    const failure = error as {
      deliveryOutcome?: string;
      safeToRetry?: boolean;
      permanent?: boolean;
    };
    const knownNotSent =
      !providerAccepted &&
      (!providerStarted ||
        failure?.deliveryOutcome === "not_sent" ||
        failure?.safeToRetry === true);
    if (knownNotSent) {
      const retryable =
        failure?.permanent !== true &&
        Number(log.attempts || 0) + 1 < maxAttempts;
      const recorded = await communicationEmailLogRepository.markFailed(
        tenantId,
        emailLogId,
        error instanceof Error
          ? error.message
          : "Booking email failed before submission.",
        claimToken,
        true,
        { retryable, countAttempt: !providerStarted },
      );
      if (!recorded)
        return { skipped: true, reason: "claim_lost_after_preflight" };
      if (!retryable)
        return {
          terminalFailure: true,
          reason: "permanent_or_exhausted_failure",
        };
      throw error;
    }
    try {
      await communicationEmailLogRepository.markAmbiguous(
        tenantId,
        emailLogId,
        "Booking email provider outcome is unknown or acceptance could not be recorded. Reconcile with Postmark before retrying.",
        claimToken,
      );
    } catch (statusError) {
      logger.error(
        { err: statusError, tenantId, emailLogId },
        "Failed to record ambiguous booking email delivery.",
      );
    }
    return { ambiguous: true, reason: "provider_outcome_unknown" };
  }
};
