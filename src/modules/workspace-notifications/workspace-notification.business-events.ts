import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import BookingModel from "@/modules/booking/booking.model.js";
import { emitCustomerCommerceNotificationsForOrderSafely } from "@/modules/customer-notifications/index.js";
import {
  DATA_IMPORT_ENTITY,
  type DataImportEntity,
} from "@/modules/data-import/data-import.constants.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import { emitWorkspaceNotificationEvent } from "./workspace-notification.events.js";

type ImportTerminalStatus = "completed" | "failed";

const IMPORT_NOTIFICATION_PERMISSION = {
  [DATA_IMPORT_ENTITY.CUSTOMERS]: WORKSPACE_PERMISSION.CUSTOMERS_IMPORT,
  [DATA_IMPORT_ENTITY.PRODUCTS]: WORKSPACE_PERMISSION.PRODUCTS_IMPORT,
  [DATA_IMPORT_ENTITY.BOOKINGS]: WORKSPACE_PERMISSION.BOOKINGS_IMPORT,
  [DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS]:
    WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
  [DATA_IMPORT_ENTITY.MEMBERSHIPS]: WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
  [DATA_IMPORT_ENTITY.CREDITS]: WORKSPACE_PERMISSION.CREDITS_IMPORT,
  [DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS]: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
  [DATA_IMPORT_ENTITY.VOUCHERS]: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
} as const satisfies Record<
  DataImportEntity,
  (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION]
>;

type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

type BookingNotificationOrder = {
  _id?: unknown;
  createdBy?: unknown;
  paidAt?: Date | string | null;
  workshopBookings?: readonly unknown[];
  courseBookings?: readonly (
    | unknown
    | {
        bookingId?: unknown;
      }
  )[];
  creditPurchase?: { amount?: unknown } | null;
};

const toValidObjectIdString = (value: unknown): string | null => {
  const normalized = String(value ?? "").trim();
  return mongoose.Types.ObjectId.isValid(normalized) ? normalized : null;
};

const getOrderBookingIds = (
  order: BookingNotificationOrder,
): readonly string[] => {
  if (Number(order.creditPurchase?.amount ?? 0) > 0) return [];

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
 * Materializes paid customer bookings into location-scoped inbox events only
 * after the owning checkout transaction has committed. Lookup and event-bus
 * failures are deliberately swallowed so notifications can never roll back a
 * completed payment.
 */
export const emitBookingCreatedNotificationsForOrderSafely = async ({
  tenantId,
  order,
}: {
  tenantId: string;
  order: BookingNotificationOrder;
}): Promise<{ candidateCount: number; emittedCount: number }> => {
  const orderId = toValidObjectIdString(order._id);
  const bookingIds = getOrderBookingIds(order);

  if (!orderId || !mongoose.Types.ObjectId.isValid(tenantId)) {
    return { candidateCount: bookingIds.length, emittedCount: 0 };
  }

  // This existing post-commit hook is shared by connected-account, legacy,
  // and synchronous checkout paths. Materialize the customer's own inbox here
  // so each payment flow receives identical idempotent behavior.
  try {
    await emitCustomerCommerceNotificationsForOrderSafely({ tenantId, order });
  } catch (error) {
    try {
      logger.error(
        { err: error, tenantId, orderId },
        "Customer commerce notification bridge failed.",
      );
    } catch {
      // A paid order is already committed; logging is best effort as well.
    }
  }

  if (bookingIds.length === 0) {
    return { candidateCount: 0, emittedCount: 0 };
  }

  try {
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
    const actorUserId = toValidObjectIdString(order.createdBy);
    const occurredAtCandidate = order.paidAt
      ? new Date(order.paidAt)
      : new Date();
    const occurredAt = Number.isFinite(occurredAtCandidate.getTime())
      ? occurredAtCandidate
      : new Date();
    let emittedCount = 0;

    for (const booking of bookings) {
      const bookingId = toValidObjectIdString(booking._id);
      const locationId = toValidObjectIdString(booking.location);
      if (!bookingId || !locationId) continue;

      emitWorkspaceNotificationEvent({
        tenantId,
        ...(actorUserId ? { actorUserId } : {}),
        requiredPermission: WORKSPACE_PERMISSION.BOOKINGS_VIEW,
        preferenceKey: "bookingAssigned",
        locationId,
        eventType: "booking.created",
        severity: "info",
        title: {
          en: "New booking",
          cs: "Nová rezervace",
        },
        message: {
          en: "A customer completed a new booking.",
          cs: "Zákazník dokončil novou rezervaci.",
        },
        actionUrl: "/app/bookings",
        sourceType: "booking",
        sourceId: bookingId,
        deduplicationKey: `booking:${orderId}:${bookingId}:created`,
        groupKey: `booking.created:${locationId}`,
        occurredAt,
      });
      emittedCount += 1;
    }

    return { candidateCount: bookingIds.length, emittedCount };
  } catch (error) {
    try {
      logger.error(
        { err: error, tenantId, orderId },
        "Paid booking notification materialization failed.",
      );
    } catch {
      // Logging must remain best effort as well.
    }

    return { candidateCount: bookingIds.length, emittedCount: 0 };
  }
};

export const emitPaymentRefundedNotificationSafely = ({
  tenantId,
  bookingId,
  actorUserId,
  locationId,
  refundAmount,
  currency,
  membershipCreditRestored = false,
}: {
  tenantId: string;
  bookingId: string;
  actorUserId: string;
  locationId: string;
  refundAmount: number;
  currency?: string;
  membershipCreditRestored?: boolean;
}): boolean => {
  const amountLabel =
    Number.isFinite(refundAmount) && refundAmount > 0 && currency
      ? `${refundAmount} ${currency}`
      : "";
  const englishMessage = membershipCreditRestored
    ? "A membership credit was restored after a booking cancellation."
    : amountLabel
      ? `A booking cancellation refund of ${amountLabel} was issued.`
      : "A booking cancellation refund was issued.";
  const czechMessage = membershipCreditRestored
    ? "Po zrušení rezervace byl obnoven členský kredit."
    : amountLabel
      ? `Byla vystavena náhrada za zrušenou rezervaci ve výši ${amountLabel}.`
      : "Byla vystavena náhrada za zrušenou rezervaci.";

  try {
    return emitWorkspaceNotificationEvent({
      tenantId,
      actorUserId,
      requiredPermission: WORKSPACE_PERMISSION.PAYMENTS_VIEW,
      locationId,
      eventType: "payment.refunded",
      severity: "success",
      title: {
        en: "Payment refunded",
        cs: "Platba byla vrácena",
      },
      message: {
        en: englishMessage,
        cs: czechMessage,
      },
      actionUrl: "/app/finance/orders",
      sourceType: "booking",
      sourceId: bookingId,
      deduplicationKey: `booking:${bookingId}:payment-refunded`,
      groupKey: `payment.refunded:${locationId}`,
    });
  } catch (error) {
    try {
      logger.error(
        { err: error, tenantId, bookingId },
        "Payment-refund notification emission failed.",
      );
    } catch {
      // Logging must remain best effort as well.
    }
    return false;
  }
};

export const emitImportTerminalNotification = ({
  tenantId,
  sessionId,
  recipientUserId,
  entityType,
  status,
  summary,
}: {
  tenantId: string;
  sessionId: string;
  recipientUserId: string;
  entityType: DataImportEntity;
  status: ImportTerminalStatus;
  summary?: ImportSummary;
}): boolean => {
  const completed = status === "completed";
  const englishSummary = summary
    ? `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} failed.`
    : "Open migration history to review the failure.";
  const czechSummary = summary
    ? `${summary.created} vytvořeno, ${summary.updated} aktualizováno, ${summary.skipped} přeskočeno, ${summary.failed} se nezdařilo.`
    : "Podrobnosti najdete v historii migrací.";

  return emitWorkspaceNotificationEvent({
    tenantId,
    recipientUserIds: [recipientUserId],
    requiredPermission: IMPORT_NOTIFICATION_PERMISSION[entityType],
    eventType: completed ? "import.completed" : "import.failed",
    severity: completed ? "success" : "critical",
    title: completed
      ? {
          en: "Import completed",
          cs: "Import byl dokončen",
        }
      : {
          en: "Import failed",
          cs: "Import se nezdařil",
        },
    message: completed
      ? {
          en: `${entityType} import completed. ${englishSummary}`,
          cs: `Import typu ${entityType} byl dokončen. ${czechSummary}`,
        }
      : {
          en: `${entityType} import failed. ${englishSummary}`,
          cs: `Import typu ${entityType} se nezdařil. ${czechSummary}`,
        },
    actionUrl: "/app/settings/migration",
    sourceType: "data-import-session",
    sourceId: sessionId,
    deduplicationKey: `import:${sessionId}:${status}`,
    groupKey: `import.${status}`,
  });
};
