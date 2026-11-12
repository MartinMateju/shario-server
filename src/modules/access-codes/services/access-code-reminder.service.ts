import { createHash, randomUUID } from "node:crypto";

import { formatDateTimeRange } from "@/modules/access-codes/access-code.utils.js";
import {
  COURSE_REMINDER_DELIVERY_STATUS,
  type CourseReminderDeliveryStatus,
} from "@/modules/access-codes/course-reminder-delivery.constants.js";
import { courseReminderDeliveryRepository } from "@/modules/access-codes/course-reminder-delivery.repository.js";
import type { CourseReminderDeliveryDocument } from "@/modules/access-codes/course-reminder-delivery.types.js";
import { logger } from "@/config/logger.js";
import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import Booking from "@/modules/booking/booking.model.js";
import { hasCommunicationAutomationBookingReminderOwner } from "@/modules/communication-automations/services/communication-automation-ownership.service.js";
import {
  CommunicationConsentModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import {
  getAllowedLegacyCourseReminderUsers,
  getEligibleLegacyCourseReminderUsers,
} from "./access-code-reminder-policy.service.js";

const DEFAULT_HOURS_AHEAD = 24;
const HOUR_IN_MS = 60 * 60 * 1000;
const MINIMUM_CLAIM_LEASE_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const COURSE_REMINDER_BATCH_LIMIT = Number(
  process.env.COURSE_REMINDER_BATCH_LIMIT || 1000,
);

const objectId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
};

const finiteNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const claimLeaseMs = (): number =>
  Math.max(
    MINIMUM_CLAIM_LEASE_MS,
    finiteNumber(
      process.env.COURSE_REMINDER_DELIVERY_CLAIM_LEASE_MS,
      DEFAULT_CLAIM_LEASE_MS,
    ),
  );

const maxDeliveryAttempts = (): number =>
  Math.floor(
    Math.min(
      8,
      Math.max(
        1,
        finiteNumber(
          process.env.COURSE_REMINDER_DELIVERY_MAX_ATTEMPTS,
          DEFAULT_MAX_ATTEMPTS,
        ),
      ),
    ),
  );

const nextRetryAt = (attempts: number, maxAttempts: number, now: Date) =>
  attempts >= maxAttempts
    ? null
    : new Date(
        now.getTime() +
          Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1)),
      );

export const buildCourseReminderIdempotencyKey = ({
  tenantId,
  bookingId,
  bookingStart,
  recipientUserId,
}: {
  tenantId: string;
  bookingId: string;
  bookingStart: Date | string;
  recipientUserId: string;
}): string => {
  const occurrence = new Date(bookingStart).toISOString();
  const digest = createHash("sha256")
    .update(
      [tenantId, bookingId, occurrence, recipientUserId]
        .map((value) => String(value).trim())
        .join("\u001f"),
    )
    .digest("hex");
  return `course-reminder-${digest}`;
};

export const buildCourseReminderMessageId = (idempotencyKey: string): string =>
  `<${idempotencyKey}@mail.shario.io>`;

export const isSmtpOutcomeKnownNotSent = (error: any): boolean => {
  if (error?.safeToRetry === true || ["not_sent", "rejected"].includes(error?.deliveryOutcome)) {
    return true;
  }
  const code = String(error?.code || "").toUpperCase();
  const command = String(error?.command || "").toUpperCase();
  return (
    ["EAUTH", "EDNS", "EENVELOPE", "EAI_AGAIN", "ENOTFOUND"].includes(code) ||
    ["AUTH", "MAIL FROM", "RCPT TO"].includes(command)
  );
};

type CourseReminderDeliveryResult = {
  status:
    | CourseReminderDeliveryStatus
    | "already_claimed"
    | "claim_lost_before_provider";
  sent: boolean;
};

type CourseReminderMailSnapshot = {
  recipientEmail: string;
  subject: string;
  textContent: string;
};

type CourseReminderMailResolution = {
  mail: CourseReminderMailSnapshot | null;
  skipReason: string;
};

type ResolveCourseReminderMail = (
  delivery: CourseReminderDeliveryDocument,
) => Promise<CourseReminderMailResolution>;

const resolveCurrentCourseReminderMail: ResolveCourseReminderMail = async (
  delivery,
) => {
  const now = new Date();
  const tenantId = objectId(delivery.tenant);
  const bookingId = objectId(delivery.booking);
  const recipientUserId = objectId(delivery.recipientUser);
  if (!tenantId || !bookingId || !recipientUserId) {
    return {
      mail: null,
      skipReason: "The durable reminder source identifiers are invalid.",
    };
  }

  const currentBookings = await Booking.find({
    _id: delivery.booking,
    tenant: delivery.tenant,
    "atelierKleiMigration.suppressHistoricalNotifications": { $ne: true },
    status: "processed",
    paymentStatus: "CONFIRMED",
    wasReminderSent: false,
    tag: { $in: ["class", "course"] },
    start: {
      $eq: new Date(delivery.bookingStart),
      $gte: now,
    },
  })
    .populate("bookingProduct")
    .populate("location", "name booking.timezone")
    .populate({
      path: "orders",
      match: { isPaid: true },
      select: "tenant createdBy isPaid",
      populate: {
        path: "createdBy",
        match: {
          tenantRole: "customer",
          isAccessGranted: { $ne: false },
        },
        select: "tenant firstname lastname email +tenantRole isAccessGranted",
      },
    })
    .lean<any[]>()
    .exec();
  const booking = currentBookings[0];
  if (!booking) {
    return {
      mail: null,
      skipReason:
        "The booking is no longer an eligible, paid, upcoming course occurrence.",
    };
  }

  if (
    await hasCommunicationAutomationBookingReminderOwner({
      tenantId,
      bookingId,
      bookingStart: booking.start,
      bookingUpdatedAt: booking.updatedAt,
      locationId: objectId(booking.location),
      productType: "course",
      now,
    })
  ) {
    return {
      mail: null,
      skipReason:
        "A communication automation now owns this booking reminder occurrence.",
    };
  }

  const currentUser = getEligibleLegacyCourseReminderUsers({
    tenantId,
    orders: booking.orders,
    booking,
  }).find((user) => objectId(user._id) === recipientUserId);
  if (!currentUser) {
    return {
      mail: null,
      skipReason:
        "The recipient is no longer an eligible paid customer for this course.",
    };
  }

  const [consents, suppressions] = await Promise.all([
    CommunicationConsentModel.find({
      tenantId,
      customerId: currentUser._id,
      channel: "email",
      purpose: "transactional",
    })
      .lean<any[]>()
      .exec(),
    CommunicationSuppressionModel.find({
      tenantId,
      channel: "email",
      identity: currentUser.email,
      active: true,
    })
      .lean<any[]>()
      .exec(),
  ]);
  const [allowedUser] = getAllowedLegacyCourseReminderUsers({
    users: [currentUser],
    consents,
    suppressions,
    now,
  });
  if (!allowedUser) {
    return {
      mail: null,
      skipReason:
        "The recipient is no longer permitted by transactional consent or suppression policy.",
    };
  }

  const courseName = booking.bookingProduct?.name || "kurz keramiky";
  const locationName = booking.location?.name || "Studio";
  const timezone = booking.location?.booking?.timezone || "UTC";
  const dateTime = formatDateTimeRange(
    new Date(booking.start),
    new Date(booking.end),
    timezone,
  );
  return {
    mail: {
      recipientEmail: allowedUser.email,
      subject: `Připomínka: ${courseName} už brzy`,
      textContent: `Dobrý den,\n\npřipomínáme, že váš kurz ${courseName} začíná ${dateTime}.\n\n${locationName}`,
    },
    skipReason: "",
  };
};

const markBookingReminderComplete = (booking: Record<string, any>) =>
  Booking.updateOne(
    {
      _id: booking._id,
      tenant: booking.tenant,
      "atelierKleiMigration.suppressHistoricalNotifications": { $ne: true },
      status: "processed",
      paymentStatus: "CONFIRMED",
      tag: { $in: ["class", "course"] },
      start: new Date(booking.start),
      wasReminderSent: false,
    },
    { $set: { wasReminderSent: true } },
  ).exec();

const markAmbiguousBestEffort = async ({
  delivery,
  claimToken,
  reason,
}: {
  delivery: CourseReminderDeliveryDocument;
  claimToken: string;
  reason: string;
}): Promise<void> => {
  try {
    await courseReminderDeliveryRepository.markAmbiguous({
      tenant: delivery.tenant,
      deliveryId: delivery._id,
      claimToken,
      reason,
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        deliveryId: objectId(delivery._id),
        idempotencyKey: delivery.idempotencyKey,
      },
      "Failed to quarantine an uncertain legacy course reminder delivery.",
    );
  }
};

export const deliverClaimedCourseReminder = async (
  delivery: CourseReminderDeliveryDocument,
  resolveMail: ResolveCourseReminderMail,
): Promise<CourseReminderDeliveryResult> => {
  if (delivery.status === COURSE_REMINDER_DELIVERY_STATUS.SENT) {
    return { status: COURSE_REMINDER_DELIVERY_STATUS.SENT, sent: false };
  }
  if (delivery.status === COURSE_REMINDER_DELIVERY_STATUS.AMBIGUOUS) {
    return { status: COURSE_REMINDER_DELIVERY_STATUS.AMBIGUOUS, sent: false };
  }
  if (delivery.status === COURSE_REMINDER_DELIVERY_STATUS.SKIPPED) {
    return { status: COURSE_REMINDER_DELIVERY_STATUS.SKIPPED, sent: false };
  }

  const claimedAt = new Date();
  const claimToken = randomUUID();
  const claimed = await courseReminderDeliveryRepository.claimForSending({
    tenant: delivery.tenant,
    idempotencyKey: delivery.idempotencyKey,
    claimToken,
    now: claimedAt,
    leaseUntil: new Date(claimedAt.getTime() + claimLeaseMs()),
  });
  if (!claimed) return { status: "already_claimed", sent: false };

  const current = await resolveMail(claimed);
  if (!current.mail) {
    const skipped = await courseReminderDeliveryRepository.markSkipped({
      tenant: claimed.tenant,
      deliveryId: claimed._id,
      claimToken,
      reason: current.skipReason || "The reminder source is no longer valid.",
    });
    return {
      status: skipped
        ? COURSE_REMINDER_DELIVERY_STATUS.SKIPPED
        : "already_claimed",
      sent: false,
    };
  }

  const providerAttempt =
    await courseReminderDeliveryRepository.beginProviderAttempt({
      tenant: claimed.tenant,
      deliveryId: claimed._id,
      claimToken,
    });
  if (!providerAttempt) {
    return { status: "claim_lost_before_provider", sent: false };
  }

  let providerResult: Awaited<ReturnType<typeof sendEmail>>;
  try {
    providerResult = await sendEmail({
      tenantId: objectId(providerAttempt.tenant),
      to: current.mail.recipientEmail,
      subject: current.mail.subject,
      text: current.mail.textContent,
      messageId: providerAttempt.messageId,
      headers: {
        "Message-ID": providerAttempt.messageId,
        "X-Shario-Delivery-Key": providerAttempt.idempotencyKey,
        "X-Shario-Booking-Id": objectId(providerAttempt.booking),
        "X-Shario-Recipient-Id": objectId(providerAttempt.recipientUser),
      },
    });
  } catch (error: any) {
    const message =
      error instanceof Error ? error.message : "Unknown email provider error.";
    if (isSmtpOutcomeKnownNotSent(error)) {
      const now = new Date();
      const attempts = Number(providerAttempt.attempts || 0);
      const maxAttempts = Number(
        providerAttempt.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      );
      const exhausted = attempts >= maxAttempts;
      const recorded = await courseReminderDeliveryRepository.markKnownNotSent({
        tenant: providerAttempt.tenant,
        deliveryId: providerAttempt._id,
        claimToken,
        errorCode: String(error?.code || "EMAIL_REJECTED"),
        errorMessage: message,
        nextAttemptAt: nextRetryAt(attempts, maxAttempts, now),
        exhausted,
        now,
      });
      return {
        status: recorded
          ? COURSE_REMINDER_DELIVERY_STATUS.FAILED
          : "already_claimed",
        sent: false,
      };
    }

    await markAmbiguousBestEffort({
      delivery: providerAttempt,
      claimToken,
      reason: `Email provider outcome is unknown: ${message}. Reconcile the stable message ID before retrying.`,
    });
    return {
      status: COURSE_REMINDER_DELIVERY_STATUS.AMBIGUOUS,
      sent: false,
    };
  }

  try {
    const recorded = await courseReminderDeliveryRepository.markSent({
      tenant: providerAttempt.tenant,
      deliveryId: providerAttempt._id,
      claimToken,
      providerMessageId: String(providerResult?.providerMessageId || ""),
    });
    if (recorded) {
      return { status: COURSE_REMINDER_DELIVERY_STATUS.SENT, sent: true };
    }
    await markAmbiguousBestEffort({
      delivery: providerAttempt,
      claimToken,
      reason:
        "Email provider accepted the reminder, but the durable sent transition lost claim ownership. Reconcile the stable message ID before retrying.",
    });
  } catch (error) {
    await markAmbiguousBestEffort({
      delivery: providerAttempt,
      claimToken,
      reason:
        "Email provider accepted the reminder, but recording the sent result failed. Reconcile the stable message ID before retrying.",
    });
    logger.error(
      {
        err: error,
        deliveryId: objectId(providerAttempt._id),
        idempotencyKey: providerAttempt.idempotencyKey,
      },
      "Email provider accepted a legacy course reminder but its sent state was not recorded.",
    );
  }
  return {
    status: COURSE_REMINDER_DELIVERY_STATUS.AMBIGUOUS,
    sent: false,
  };
};

export async function sendUpcomingCourseReminders(
  hoursAhead = DEFAULT_HOURS_AHEAD,
): Promise<number> {
  const now = new Date();
  const until = new Date(now.getTime() + hoursAhead * HOUR_IN_MS);
  const recovered = await courseReminderDeliveryRepository.recoverStaleClaims({
    now,
  });
  if (recovered.requeued || recovered.ambiguous) {
    logger.warn(
      recovered,
      "Recovered stale legacy course reminder delivery claims.",
    );
  }

  const bookings = await Booking.find({
    "atelierKleiMigration.suppressHistoricalNotifications": { $ne: true },
    status: "processed",
    paymentStatus: "CONFIRMED",
    wasReminderSent: false,
    tag: { $in: ["class", "course"] },
    start: {
      $gte: now,
      $lte: until,
    },
  })
    .populate("bookingProduct")
    .populate("location", "name booking.timezone")
    .populate({
      path: "orders",
      match: { isPaid: true },
      select: "tenant createdBy isPaid",
      populate: {
        path: "createdBy",
        match: {
          tenantRole: "customer",
          isAccessGranted: { $ne: false },
        },
        select: "tenant firstname lastname email +tenantRole isAccessGranted",
      },
    })
    // This job runs platform-wide (every tenant's upcoming class/course
    // bookings in the window at once), not scoped to a single tenant, so a
    // safety cap is the only bound on it as the platform grows. Both callers
    // (the hourly cron and the manual admin trigger) only ever consume the
    // returned count, never the booking list itself, so capping the batch
    // just means a very large hour's worth of reminders spans two runs.
    .limit(COURSE_REMINDER_BATCH_LIMIT)
    .lean<any[]>()
    .exec();

  let sentCount = 0;

  for (const booking of bookings) {
    const tenantId = objectId(booking.tenant);
    const bookingId = objectId(booking._id);
    const ownedByAutomation = tenantId
      ? await hasCommunicationAutomationBookingReminderOwner({
          tenantId,
          bookingId,
          bookingStart: booking.start,
          bookingUpdatedAt: booking.updatedAt,
          locationId: objectId(booking.location),
          productType: "course",
          now,
        })
      : false;
    if (ownedByAutomation) {
      logger.info(
        { tenantId, bookingId },
        "Legacy course reminder skipped because communication automation owns it.",
      );
      continue;
    }

    const eligibleUsers = getEligibleLegacyCourseReminderUsers({
      tenantId,
      orders: booking.orders,
      booking,
    });
    if (!eligibleUsers.length) continue;

    const userIds = eligibleUsers.map((user) => objectId(user._id));
    const emails = eligibleUsers.map((user) => user.email);
    const [consents, suppressions] = await Promise.all([
      CommunicationConsentModel.find({
        tenantId,
        customerId: { $in: userIds },
        channel: "email",
        purpose: "transactional",
      })
        .lean<any[]>()
        .exec(),
      CommunicationSuppressionModel.find({
        tenantId,
        channel: "email",
        identity: { $in: emails },
        active: true,
      })
        .lean<any[]>()
        .exec(),
    ]);
    const allowedUsers = getAllowedLegacyCourseReminderUsers({
      users: eligibleUsers,
      consents,
      suppressions,
      now,
    });
    if (!allowedUsers.length) {
      await markBookingReminderComplete(booking);
      continue;
    }

    const courseName = booking.bookingProduct?.name || "kurz keramiky";
    const locationName = booking.location?.name || "Studio";
    const timezone = booking.location?.booking?.timezone || "UTC";
    const dateTime = formatDateTimeRange(
      new Date(booking.start),
      new Date(booking.end),
      timezone,
    );
    const subject = `Připomínka: ${courseName} už brzy`;
    const textContent = `Dobrý den,\n\npřipomínáme, že váš kurz ${courseName} začíná ${dateTime}.\n\n${locationName}`;
    const idempotencyKeys: string[] = [];

    for (const user of allowedUsers) {
      const recipientUserId = objectId(user._id);
      const idempotencyKey = buildCourseReminderIdempotencyKey({
        tenantId,
        bookingId,
        bookingStart: booking.start,
        recipientUserId,
      });
      idempotencyKeys.push(idempotencyKey);
      try {
        const delivery = await courseReminderDeliveryRepository.upsertPending({
          tenant: booking.tenant,
          booking: booking._id,
          bookingStart: new Date(booking.start),
          recipientUser: user._id as never,
          recipientEmail: user.email,
          idempotencyKey,
          messageId: buildCourseReminderMessageId(idempotencyKey),
          subject,
          textContent,
          maxAttempts: maxDeliveryAttempts(),
        });
        const result = await deliverClaimedCourseReminder(
          delivery,
          resolveCurrentCourseReminderMail,
        );
        sentCount += Number(result.sent);
      } catch (error) {
        logger.error(
          {
            err: error,
            tenantId,
            bookingId,
            recipientUserId,
            idempotencyKey,
          },
          "Legacy course reminder recipient processing failed.",
        );
      }
    }

    if (
      await courseReminderDeliveryRepository.areAllCompleted({
        tenant: booking.tenant,
        booking: booking._id,
        idempotencyKeys,
      })
    ) {
      await markBookingReminderComplete(booking);
    }
  }

  logger.info(
    {
      bookings: bookings.length,
      sentCount,
      recovered,
    },
    "Upcoming course reminders processed.",
  );

  return sentCount;
}
