import mongoose, { type ClientSession } from "mongoose";

import { logger } from "@/config/logger.js";
import BookingModel from "@/modules/booking/booking.model.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

import {
  CUSTOMER_NOTIFICATION_EVENT,
  CUSTOMER_NOTIFICATION_SEVERITY,
} from "./customer-notification.constants.js";
import type {
  CustomerNotificationLocalizedText,
  PublishCustomerNotificationInput,
} from "./customer-notification.types.js";
import {
  publishCustomerNotification,
  publishCustomerNotificationSafely,
} from "./services/customer-notification-publisher.service.js";

const toValidObjectIdString = (value: unknown): string | null => {
  const normalized = String(
    value && typeof value === "object" && "_id" in value
      ? (value as { _id?: unknown })._id
      : (value ?? ""),
  ).trim();
  return mongoose.Types.ObjectId.isValid(normalized) ? normalized : null;
};

const bilingual = (
  en: string,
  cs: string,
): CustomerNotificationLocalizedText => ({ en, cs });

type CustomerNotificationOrder = {
  _id?: unknown;
  createdBy?: unknown;
  paidAt?: Date | string | null;
  workshopBookings?: readonly unknown[];
  courseBookings?: readonly (unknown | { bookingId?: unknown })[];
  creditPurchase?: { amount?: unknown; currency?: unknown } | null;
  currency?: unknown;
};

const getOrderBookingIds = (order: CustomerNotificationOrder): string[] => {
  const workshopIds = (order.workshopBookings ?? [])
    .map(toValidObjectIdString)
    .filter((value): value is string => Boolean(value));
  const courseIds = (order.courseBookings ?? [])
    .map((course) =>
      course && typeof course === "object" && "bookingId" in course
        ? toValidObjectIdString(course.bookingId)
        : null,
    )
    .filter((value): value is string => Boolean(value));
  return [...new Set([...workshopIds, ...courseIds])];
};

/**
 * Post-commit hook for both connected-account and legacy checkout flows.
 * Stripe retries are harmless because order/source keys are recipient-unique.
 */
export const emitCustomerCommerceNotificationsForOrderSafely = async ({
  tenantId,
  order,
}: {
  tenantId: string;
  order: CustomerNotificationOrder;
}): Promise<{ candidateCount: number; createdCount: number }> => {
  const orderId = toValidObjectIdString(order._id);
  const recipientUserId = toValidObjectIdString(order.createdBy);
  if (
    !orderId ||
    !recipientUserId ||
    !mongoose.Types.ObjectId.isValid(tenantId)
  ) {
    return { candidateCount: 0, createdCount: 0 };
  }

  const occurredAtCandidate = order.paidAt
    ? new Date(order.paidAt)
    : new Date();
  const occurredAt = Number.isFinite(occurredAtCandidate.getTime())
    ? occurredAtCandidate
    : new Date();
  let candidateCount = 0;
  let createdCount = 0;

  try {
    const creditAmount = Number(order.creditPurchase?.amount ?? 0);
    if (Number.isFinite(creditAmount) && creditAmount > 0) {
      candidateCount += 1;
      const currency = String(
        order.creditPurchase?.currency ?? order.currency ?? "",
      ).toUpperCase();
      const result = await publishCustomerNotificationSafely({
        tenantId,
        recipientUserId,
        eventType: CUSTOMER_NOTIFICATION_EVENT.CREDITS_PURCHASED,
        severity: CUSTOMER_NOTIFICATION_SEVERITY.SUCCESS,
        title: bilingual("Credits purchased", "Kredity byly zakoupeny"),
        message: bilingual(
          `Your credit purchase${currency ? ` of ${creditAmount} ${currency}` : ""} is available in your account.`,
          `Zakoupené kredity${currency ? ` ve výši ${creditAmount} ${currency}` : ""} jsou dostupné na vašem účtu.`,
        ),
        actionUrl: "/portal/credits",
        sourceType: "order",
        sourceId: orderId,
        deduplicationKey: `order:${orderId}:credits-purchased`,
        occurredAt,
      });
      createdCount += result.createdCount;
      return { candidateCount, createdCount };
    }

    const bookingIds = getOrderBookingIds(order);
    candidateCount += bookingIds.length;
    if (bookingIds.length === 0) return { candidateCount, createdCount };

    const bookings = await BookingModel.find({
      tenant: new mongoose.Types.ObjectId(tenantId),
      _id: {
        $in: bookingIds.map(
          (bookingId) => new mongoose.Types.ObjectId(bookingId),
        ),
      },
    })
      .select("_id location")
      .lean()
      .exec();

    for (const booking of bookings) {
      const bookingId = toValidObjectIdString(booking._id);
      const locationId = toValidObjectIdString(booking.location);
      if (!bookingId) continue;
      const result = await publishCustomerNotificationSafely({
        tenantId,
        recipientUserId,
        ...(locationId ? { locationId } : {}),
        eventType: CUSTOMER_NOTIFICATION_EVENT.BOOKING_CREATED,
        severity: CUSTOMER_NOTIFICATION_SEVERITY.SUCCESS,
        title: bilingual("Booking confirmed", "Rezervace potvrzena"),
        message: bilingual(
          "Your booking is confirmed and available in the customer portal.",
          "Vaše rezervace je potvrzena a dostupná v zákaznickém portálu.",
        ),
        actionUrl: "/portal/bookings",
        sourceType: "booking",
        sourceId: bookingId,
        deduplicationKey: `booking:${orderId}:${bookingId}:customer-confirmed`,
        occurredAt,
      });
      createdCount += result.createdCount;
    }

    return { candidateCount, createdCount };
  } catch (error) {
    try {
      logger.error(
        { err: error, tenantId, orderId, recipientUserId },
        "Customer commerce notification materialization failed.",
      );
    } catch {
      // Post-commit notification failure must never fail a paid order.
    }
    return { candidateCount, createdCount };
  }
};

type CustomerBookingLifecycleNotificationInput = {
  tenantId: string;
  recipientUserId: string;
  bookingId: string;
  locationId?: string | null;
  occurredAt?: Date;
} & (
  | { event: "cancelled"; transitionKey?: never }
  | {
      event: "rescheduled";
      /** Persisted new start/revision; required for replay-safe deduplication. */
      transitionKey: string;
    }
);

export const publishCustomerBookingLifecycleNotificationSafely = ({
  tenantId,
  recipientUserId,
  bookingId,
  locationId,
  event,
  transitionKey,
  occurredAt = new Date(),
}: CustomerBookingLifecycleNotificationInput) => {
  const stableTransitionKey = transitionKey?.trim() ?? "";
  if (event === "rescheduled" && !stableTransitionKey) {
    return Promise.resolve({
      ok: false as const,
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    });
  }

  return publishCustomerNotificationSafely({
    tenantId,
    recipientUserId,
    ...(locationId ? { locationId } : {}),
    eventType:
      event === "cancelled"
        ? CUSTOMER_NOTIFICATION_EVENT.BOOKING_CANCELLED
        : CUSTOMER_NOTIFICATION_EVENT.BOOKING_RESCHEDULED,
    severity:
      event === "cancelled"
        ? CUSTOMER_NOTIFICATION_SEVERITY.WARNING
        : CUSTOMER_NOTIFICATION_SEVERITY.INFO,
    title:
      event === "cancelled"
        ? bilingual("Booking cancelled", "Rezervace zrušena")
        : bilingual("Booking rescheduled", "Rezervace přesunuta"),
    message:
      event === "cancelled"
        ? bilingual(
            "Your booking has been cancelled.",
            "Vaše rezervace byla zrušena.",
          )
        : bilingual(
            "Your booking has been moved to its new time.",
            "Vaše rezervace byla přesunuta na nový čas.",
          ),
    actionUrl: "/portal/bookings",
    sourceType: "booking",
    sourceId: bookingId,
    deduplicationKey:
      event === "cancelled"
        ? `booking:${bookingId}:customer-cancelled`
        : `booking:${bookingId}:customer-rescheduled:${stableTransitionKey}`,
    occurredAt,
  });
};

export const publishCustomerRefundNotificationSafely = ({
  tenantId,
  recipientUserId,
  bookingId,
  locationId,
  refundAmount,
  currency,
  membershipCreditRestored = false,
  refundKey,
}: {
  tenantId: string;
  recipientUserId: string;
  bookingId: string;
  locationId?: string | null;
  refundAmount: number;
  currency?: string;
  membershipCreditRestored?: boolean;
  /** Persisted credit transaction, refund, or intent id. */
  refundKey: string;
}) => {
  const stableRefundKey = refundKey.trim();
  if (!stableRefundKey) {
    return Promise.resolve({
      ok: false as const,
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    });
  }
  const amount =
    Number.isFinite(refundAmount) && refundAmount > 0 && currency
      ? `${refundAmount} ${currency}`
      : "";
  return publishCustomerNotificationSafely({
    tenantId,
    recipientUserId,
    ...(locationId ? { locationId } : {}),
    eventType: CUSTOMER_NOTIFICATION_EVENT.PAYMENT_REFUNDED,
    severity: CUSTOMER_NOTIFICATION_SEVERITY.SUCCESS,
    title: bilingual("Credit restored", "Kredit byl obnoven"),
    message: membershipCreditRestored
      ? bilingual(
          "Your membership credit was restored after the cancellation.",
          "Po zrušení rezervace byl obnoven váš členský kredit.",
        )
      : bilingual(
          `Your cancellation credit${amount ? ` of ${amount}` : ""} was added to your studio balance.`,
          `Kredit za zrušení rezervace${amount ? ` ve výši ${amount}` : ""} byl přidán k vašemu zůstatku ve studiu.`,
        ),
    actionUrl: "/portal/credits",
    sourceType: "booking",
    sourceId: bookingId,
    deduplicationKey: `booking:${bookingId}:customer-refund:${stableRefundKey}`,
  });
};

const MEMBERSHIP_COPY = {
  activated: [
    "Membership activated",
    "Členství aktivováno",
    "Your membership is active.",
    "Vaše členství je aktivní.",
  ],
  renewed: [
    "Membership renewed",
    "Členství obnoveno",
    "Your membership has renewed.",
    "Vaše členství bylo obnoveno.",
  ],
  assigned: [
    "Membership assigned",
    "Členství přiřazeno",
    "The studio assigned a membership to your account.",
    "Studio přiřadilo členství k vašemu účtu.",
  ],
  payment_failed: [
    "Membership payment needs attention",
    "Platba členství vyžaduje pozornost",
    "We could not collect your membership payment. Review your billing details.",
    "Platbu členství se nepodařilo provést. Zkontrolujte své platební údaje.",
  ],
  cancellation_scheduled: [
    "Membership cancellation scheduled",
    "Zrušení členství naplánováno",
    "Your membership remains available until the current period ends.",
    "Členství zůstává dostupné do konce aktuálního období.",
  ],
  cancelled: [
    "Membership cancelled",
    "Členství zrušeno",
    "Your membership has been cancelled.",
    "Vaše členství bylo zrušeno.",
  ],
  resumed: [
    "Membership continues",
    "Členství pokračuje",
    "Your scheduled cancellation was removed.",
    "Naplánované zrušení členství bylo odstraněno.",
  ],
} as const;

export type CustomerMembershipNotificationType = keyof typeof MEMBERSHIP_COPY;

export const publishCustomerMembershipNotification = ({
  tenantId,
  recipientUserId,
  membershipId,
  type,
  deduplicationKey,
  session,
}: {
  tenantId: string;
  recipientUserId: string;
  membershipId: string;
  type: CustomerMembershipNotificationType;
  deduplicationKey: string;
  session?: ClientSession | null;
}) => {
  const copy = MEMBERSHIP_COPY[type];
  return publishCustomerNotification({
    tenantId,
    recipientUserId,
    eventType:
      `membership.${type}` as PublishCustomerNotificationInput["eventType"],
    severity:
      type === "payment_failed"
        ? CUSTOMER_NOTIFICATION_SEVERITY.WARNING
        : type === "cancelled"
          ? CUSTOMER_NOTIFICATION_SEVERITY.INFO
          : CUSTOMER_NOTIFICATION_SEVERITY.SUCCESS,
    title: bilingual(copy[0], copy[1]),
    message: bilingual(copy[2], copy[3]),
    actionUrl: "/portal/membership",
    sourceType: "membership",
    sourceId: membershipId,
    deduplicationKey,
    session,
  });
};

const WAITLIST_COPY = {
  joined: [
    "You're on the waitlist",
    "Jste na čekací listině",
    "Your place on the waitlist is confirmed.",
    "Vaše místo na čekací listině je potvrzeno.",
  ],
  offered: [
    "A place is available",
    "Uvolnilo se místo",
    "A place is being held for you. Complete checkout before it expires.",
    "Místo je pro vás dočasně rezervováno. Dokončete objednávku před vypršením nabídky.",
  ],
  expired: [
    "Waitlist offer expired",
    "Nabídka z čekací listiny vypršela",
    "The offer window ended and the place was released.",
    "Čas nabídky vypršel a místo bylo uvolněno.",
  ],
  withdrawn: [
    "Waitlist withdrawal confirmed",
    "Odhlášení z čekací listiny potvrzeno",
    "You have left the waitlist.",
    "Byli jste odhlášeni z čekací listiny.",
  ],
  cancelled: [
    "Waitlist entry cancelled",
    "Čekací listina zrušena",
    "The studio cancelled this waitlist entry.",
    "Studio zrušilo tuto položku čekací listiny.",
  ],
  confirmed: [
    "Place confirmed",
    "Místo potvrzeno",
    "Your waitlist place was converted into a confirmed booking.",
    "Vaše místo z čekací listiny bylo převedeno na potvrzenou rezervaci.",
  ],
  refunded: [
    "Waitlist payment refunded",
    "Platba z čekací listiny vrácena",
    "Your late waitlist payment was refunded to the original payment method.",
    "Pozdní platba z čekací listiny byla vrácena původním způsobem platby.",
  ],
} as const;

export type CustomerWaitlistNotificationType = keyof typeof WAITLIST_COPY;

export const publishCustomerWaitlistNotification = ({
  tenantId,
  recipientUserId,
  entryId,
  locationId,
  type,
  deduplicationKey,
  session,
  occurredAt,
}: {
  tenantId: string;
  recipientUserId: string;
  entryId: string;
  locationId?: string | null;
  type: CustomerWaitlistNotificationType;
  deduplicationKey: string;
  session?: ClientSession | null;
  occurredAt?: Date;
}) => {
  const copy = WAITLIST_COPY[type];
  return publishCustomerNotification({
    tenantId,
    recipientUserId,
    eventType:
      `waitlist.${type}` as PublishCustomerNotificationInput["eventType"],
    severity:
      type === "offered" || type === "confirmed"
        ? CUSTOMER_NOTIFICATION_SEVERITY.SUCCESS
        : type === "expired" || type === "cancelled"
          ? CUSTOMER_NOTIFICATION_SEVERITY.WARNING
          : CUSTOMER_NOTIFICATION_SEVERITY.INFO,
    title: bilingual(copy[0], copy[1]),
    message: bilingual(copy[2], copy[3]),
    actionUrl: "/portal/waitlists",
    ...(locationId ? { locationId } : {}),
    sourceType: "waitlist-entry",
    sourceId: entryId,
    deduplicationKey,
    session,
    occurredAt,
  });
};

export const publishCustomerVoucherRedeemedNotificationSafely = ({
  tenantId,
  recipientUserId,
  couponId,
  creditsAdded,
  currency,
}: {
  tenantId: string;
  recipientUserId: string;
  couponId: string;
  creditsAdded: number;
  currency: StudioCommerceCurrency | string;
}) =>
  publishCustomerNotificationSafely({
    tenantId,
    recipientUserId,
    eventType: CUSTOMER_NOTIFICATION_EVENT.VOUCHER_REDEEMED,
    severity: CUSTOMER_NOTIFICATION_SEVERITY.SUCCESS,
    title: bilingual("Voucher redeemed", "Poukaz uplatněn"),
    message: bilingual(
      `${creditsAdded} ${currency} was added to your studio credits.`,
      `${creditsAdded} ${currency} bylo přidáno k vašim kreditům ve studiu.`,
    ),
    actionUrl: "/portal/credits",
    sourceType: "coupon",
    sourceId: couponId,
    deduplicationKey: `coupon:${couponId}:customer-redeemed`,
  });
