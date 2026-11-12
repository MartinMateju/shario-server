import { getBookingAutomationSourceAnchor } from "./communication-automation-schedule.service.js";
import { COMMUNICATION_SCHEDULE_TYPE } from "../communication-automation.constants.js";
import { CLASS_BOOKING_TAGS } from "@/modules/booking/booking.constants.js";
import { hasActiveOrderAttendance } from "@/modules/booking/booking.attendance-read.js";

const getId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
};

export const getCommunicationEmailSourceInvalidReason = ({
  automation,
  log,
  entity,
  recipientIsEligible,
  now = new Date(),
}: {
  automation: Record<string, any>;
  log: Record<string, any>;
  entity: Record<string, any> | null;
  recipientIsEligible: boolean;
  now?: Date;
}): string | null => {
  if (getId(log.user) && !recipientIsEligible) {
    return "Recipient is no longer an eligible customer.";
  }
  if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_REGISTRATION) {
    if (log.relatedEntityType !== "user" || !log.relatedEntityId) {
      return "Registration source is missing.";
    }
    const activatedAt = new Date(automation.activatedAt || "");
    const registeredAt = new Date(entity?.createdAt || "");
    if (
      !Number.isFinite(activatedAt.getTime()) ||
      !Number.isFinite(registeredAt.getTime())
    ) {
      return "Registration activation or source date is missing or invalid.";
    }
    if (registeredAt < activatedAt) {
      return "Customer registered before this automation was activated.";
    }
  }
  if (!log.relatedEntityId) return null;
  if (!entity) return "Source entity no longer exists.";

  const recipientUserId = getId(log.user);
  if (log.relatedEntityType === "booking") {
    if (entity.atelierKleiMigration?.suppressHistoricalNotifications === true) {
      return "Booking notifications are suppressed by its migration policy.";
    }
    if (entity.status === "cancelled" || entity.status === "canceled") {
      return "Booking was cancelled.";
    }
    if (entity.paymentStatus !== "CONFIRMED") {
      return "Booking payment is no longer confirmed.";
    }
    const isBookingConfirmation =
      automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_BOOKING_CREATED;
    if (isBookingConfirmation) {
      const sourceOrderId = getId(log.sourceOrderId);
      const orders = Array.isArray(entity.orders) ? entity.orders : [];
      const order = sourceOrderId && recipientUserId && orders.find(
        (item: any) =>
          getId(item) === sourceOrderId &&
          item.isPaid === true &&
          getId(item.createdBy) === recipientUserId,
      );
      if (!order) return "Recipient no longer owns the confirmed booking order.";
      const paidAt = new Date(order.paidAt || "");
      const sourcePaidAt = new Date(log.sourceScheduledAt || "");
      if (
        !Number.isFinite(paidAt.getTime()) ||
        !Number.isFinite(sourcePaidAt.getTime()) ||
        paidAt.getTime() !== sourcePaidAt.getTime()
      ) {
        return "Booking confirmation changed.";
      }
    }
    if (
      ["beforeBooking", "beforePurchase"].includes(
        String(automation.scheduleType),
      )
    ) {
      const start = new Date(entity.start || "");
      if (!Number.isNaN(start.getTime()) && start.getTime() <= now.getTime()) {
        return "Booking has already started.";
      }
    }
    if (recipientUserId) {
      const orders = Array.isArray(entity.orders) ? entity.orders : [];
      const ownsPaidOrder = orders.some(
        (order: any) =>
          order?.isPaid === true &&
          getId(order.createdBy) === recipientUserId,
      );
      const ownsDirectBooking =
        orders.length === 0 && getId(entity.createdBy) === recipientUserId;
      if (!ownsPaidOrder && !ownsDirectBooking) {
        return "Recipient no longer owns a paid booking order.";
      }
      if (
        ["beforeBooking", "beforePurchase"].includes(
          String(automation.scheduleType),
        ) &&
        (CLASS_BOOKING_TAGS as readonly string[]).includes(String(entity.tag)) &&
        !orders.some(
          (order: any) =>
            order?.isPaid === true &&
            getId(order.createdBy) === recipientUserId &&
            hasActiveOrderAttendance(entity, getId(order)),
        )
      ) {
        return "Recipient no longer has an active place in this course.";
      }
    }
    if (!isBookingConfirmation && automation.cancelOnReschedule !== false) {
      const currentAnchor = getBookingAutomationSourceAnchor(
        { scheduleType: String(automation.scheduleType) },
        entity,
      );
      const originalAnchor = new Date(
        log.sourceScheduledAt || log.scheduledFor || "",
      );
      if (
        !currentAnchor ||
        Number.isNaN(originalAnchor.getTime()) ||
        Math.abs(currentAnchor.getTime() - originalAnchor.getTime()) > 1_000
      ) {
        return "Booking was rescheduled.";
      }
    }
  }

  if (
    log.relatedEntityType === "user" &&
    recipientUserId &&
    getId(entity._id) !== recipientUserId
  ) {
    return "Registration source no longer belongs to this recipient.";
  }

  return null;
};
