import type { Types } from "mongoose";

import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "./booking.constants.js";

export type CustomerReservationState =
  | "confirmed"
  | "awaiting_payment"
  | "awaiting_confirmation"
  | "expired"
  | "failed"
  | "cancelled"
  | "completed";

type ReservationSource = {
  status?: unknown;
  paymentStatus?: unknown;
  paymentExpiresAt?: unknown;
  tag?: unknown;
  end?: unknown;
};

export type CustomerReservationContext = {
  now?: Date;
  hasPaidOrder?: boolean;
};

const terminalStatuses = [
  BOOKING_STATUS.CANCELLED,
  "canceled",
  BOOKING_STATUS.COMPLETED,
];

export const getCustomerReservationState = (
  booking: ReservationSource,
  { now = new Date(), hasPaidOrder = false }: CustomerReservationContext = {},
): CustomerReservationState => {
  const status = String(booking.status || "").toLowerCase();
  if (status === BOOKING_STATUS.CANCELLED || status === "canceled") {
    return "cancelled";
  }
  const endsAt = new Date(booking.end as never).getTime();
  // The delivery job runs one hour after START, including during long visits.
  if (
    status === BOOKING_STATUS.COMPLETED ||
    (status === BOOKING_STATUS.DELIVERED &&
      Number.isFinite(endsAt) &&
      endsAt < now.getTime())
  ) {
    return "completed";
  }

  // Customer-owned Class sessions are selected through paid, processed orders.
  // Their shared booking's payment state is not the participant's payment state.
  const isCourse = (CLASS_BOOKING_TAGS as readonly string[]).includes(
    String(booking.tag),
  );
  const paymentStatus = String(booking.paymentStatus || "").toUpperCase();
  if (
    isCourse ||
    !paymentStatus ||
    paymentStatus === PAYMENT_STATUS.CONFIRMED
  ) {
    return "confirmed";
  }
  // Payment evidence must remain visible even when fulfillment has not updated
  // the booking. This is an attention state, not permission to occupy capacity.
  if (hasPaidOrder) return "awaiting_confirmation";
  if (paymentStatus === PAYMENT_STATUS.PENDING_PAYMENT) {
    const expiry = new Date(booking.paymentExpiresAt as never).getTime();
    return Number.isFinite(expiry) && expiry > now.getTime()
      ? "awaiting_payment"
      : "expired";
  }
  return paymentStatus === PAYMENT_STATUS.EXPIRED ? "expired" : "failed";
};

// This filters customer booking lists only. Availability/capacity keeps its existing
// independent payment predicate; paid-but-unfulfilled rows do not consume seats.
export const customerReservationScopeFilter = (
  scope: "upcoming" | "history" | "all",
  now: Date,
  paidStudioBookingIds: Types.ObjectId[],
): Record<string, unknown> => {
  if (scope === "all") return {};

  const visibleReservation = {
    $or: [
      { tag: { $in: CLASS_BOOKING_TAGS } },
      { paymentStatus: { $in: [null, "", /^CONFIRMED$/i] } },
      {
        paymentStatus: /^PENDING_PAYMENT$/i,
        paymentExpiresAt: { $gt: now },
      },
      { _id: { $in: paidStudioBookingIds } },
    ],
  };

  return scope === "upcoming"
    ? {
        end: { $gte: now },
        status: { $nin: terminalStatuses },
        $and: [visibleReservation],
      }
    : {
        $and: [
          {
            $or: [
              { end: { $lt: now } },
              { status: { $in: terminalStatuses } },
              { $nor: [visibleReservation] },
            ],
          },
        ],
      };
};
