import { SLOT_MINUTES } from "./booking.constants.js";
import moment from "moment";

/**
 * Calculates the exact fractional hours between two dates. Booking products
 * are sold in sub-hour blocks, so truncating 30- or 90-minute reservations
 * corrupts fulfillment and refund snapshots.
 *
 * @param start - The start date/time.
 * @param end - The end date/time.
 * @returns The number of hours, including fractional hours.
 */
export const getNumberOfHours = (
  start: string | Date,
  end: string | Date,
): number => {
  const startDate = moment(start);
  const endDate = moment(end);

  return endDate.diff(startDate, "minutes", true) / 60;
};

export const calculateBookingBlocks = (start: Date, end: Date): number => {
  if (!(start instanceof Date) || !(end instanceof Date)) {
    throw new Error("Start and end must be Date objects");
  }
  if (end <= start) return 0;

  const startMinutes = start.getHours() * 60 + start.getMinutes();
  let endMinutes = end.getHours() * 60 + end.getMinutes();

  if (end.getHours() === 0 && end.getMinutes() === 0 && end > start) {
    endMinutes = 24 * 60;
  }

  return Math.max(
    0,
    Math.ceil(endMinutes / SLOT_MINUTES) -
      Math.floor(startMinutes / SLOT_MINUTES),
  );
};

type BookingLike = {
  start?: string | number | Date;
};

export const getFilteredBookingsByDate = <TBooking extends BookingLike>(
  bookings: TBooking[],
  targetBooking: BookingLike,
): TBooking[] => {
  if (!Array.isArray(bookings) || !targetBooking?.start) return [];
  const targetDay = new Date(targetBooking.start).toISOString().slice(0, 10);
  return bookings.filter(
    (booking) =>
      booking.start &&
      new Date(booking.start).toISOString().slice(0, 10) === targetDay,
  );
};
