import {
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
} from "@/modules/booking/booking.constants.js";
import type { ReportPeriod } from "@/modules/reports/reports.types.js";
import {
  inManagementPeriod,
  managementDate,
  managementId,
} from "./dashboard-management.calculations.js";

/** A booking action, not attendance: later cancellations do not erase it. */
export const managementActiveCustomerIds = ({
  bookings,
  courseOrders,
  courseBookings,
  period,
  asOf,
}: {
  bookings: any[];
  courseOrders: any[];
  courseBookings: any[];
  period: ReportPeriod;
  asOf: Date;
}): Set<string> => {
  const customers = new Set<string>();
  const cutoff = new Date(Math.min(asOf.valueOf(), period.endExclusive.valueOf()));
  const createdInPeriod = (value: unknown) =>
    inManagementPeriod(value, period) && managementDate(value)! < cutoff;
  for (const booking of bookings) {
    const confirmedAt = managementDate(booking.paymentConfirmedAt);
    if (
      !(OPEN_STUDIO_BOOKING_TAGS as readonly string[]).includes(booking.tag) ||
      !["processed", "delivered", "completed", "cancelled"].includes(booking.status) ||
      !["CONFIRMED", null, undefined, ""].includes(booking.paymentStatus) ||
      !createdInPeriod(booking.createdAt) ||
      (confirmedAt && confirmedAt >= cutoff)
    ) continue;
    const customer = managementId(booking.createdBy);
    if (customer) customers.add(customer);
  }
  // Classes are created by instructors. A customer's reservation is recorded
  // by the completed checkout order, never by the class creation timestamp.
  const visibleClasses = new Set(courseBookings
    .filter((booking) => (CLASS_BOOKING_TAGS as readonly string[]).includes(booking.tag))
    .map((booking) => managementId(booking._id)));
  for (const order of courseOrders) {
    const paidAt = managementDate(order.paidAt);
    if (order.isPaid !== true ||
      !["processed_order", "cancelled_order"].includes(order.status) ||
      !createdInPeriod(order.createdAt) ||
      (paidAt && paidAt >= cutoff)) continue;
    if (!(order.courseBookings || []).some((slot: any) =>
      Number.isSafeInteger(slot.quantity) && slot.quantity > 0 &&
      visibleClasses.has(managementId(slot.bookingId)))) continue;
    const customer = managementId(order.createdBy);
    if (customer) customers.add(customer);
  }
  return customers;
};

/** Missing identities/history must not become a plausible zero. */
export const managementSubscriberCounts = ({
  memberships,
  period,
  asOf,
  currentSnapshot,
}: {
  memberships: any[];
  period: ReportPeriod;
  asOf: Date;
  currentSnapshot: boolean;
}): { active: number | null; newSubscribers: number | null } => {
  const active = new Set<string>();
  const first = new Map<string, Date>();
  let activeKnown = currentSnapshot;
  let firstKnown = true;
  for (const row of memberships) {
    const id = managementId(row.user);
    const started = managementDate(row.startedAt);
    if (!started) {
      // Pending checkout is not an activation; any other undated historical
      // membership means the first subscriber activation cannot be established.
      const neverActivatedCheckout = row.assignmentSource === "checkout" &&
        !row.startedAt && !row.currentPeriodStart && !row.currentPeriodEnd &&
        ["expired", "cancelled", "past_due", "paused"].includes(row.status);
      if (row.status !== "pending" && !neverActivatedCheckout) firstKnown = false;
    } else if (started < asOf) {
      if (!id) firstKnown = false;
      else if (!first.has(id) || started < first.get(id)!) first.set(id, started);
    }
    if (!["active", "cancel_scheduled"].includes(row.status)) continue;
    const end = managementDate(row.currentPeriodEnd);
    const periodStart = managementDate(row.currentPeriodStart) || started;
    if (!started || !end || !periodStart || !id) {
      activeKnown = false;
      continue;
    }
    if (started <= asOf && periodStart <= asOf && end > asOf) active.add(id);
  }
  return {
    active: activeKnown ? active.size : null,
    newSubscribers: firstKnown
      ? [...first.values()].filter((started) => inManagementPeriod(started, period)).length
      : null,
  };
};
