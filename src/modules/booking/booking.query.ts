import {
  BOOKING_STATUS,
  BOOKING_TAG,
  CLASS_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "./booking.constants.js";

type LocationFilterArgs = {
  location?: string;
};

export const visibleBookingsQuery = ({
  location,
}: LocationFilterArgs = {}) => ({
  tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
  status: { $ne: BOOKING_STATUS.CANCELLED },
  paymentStatus: PAYMENT_STATUS.CONFIRMED,
  start: { $gte: new Date(Date.now() - 8 * 60 * 60 * 1000) },
  ...(location ? { location } : {}),
});

export const bookingHistoryQuery = ({ location }: LocationFilterArgs = {}) => ({
  status: { $ne: BOOKING_STATUS.CANCELLED },
  start: { $gte: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
  ...(location ? { location } : {}),
});

export const futureCourseBookingsQuery = () => ({
  tag: { $in: CLASS_BOOKING_TAGS },
  start: { $gte: new Date(Date.now() - 25_000_000) },
});
