import type { ClientSession } from "mongoose";

import { CLASS_BOOKING_TAGS } from "@/modules/booking/booking.constants.js";
import ProductModel from "@/modules/product/product.model.js";

const CLASS_TAGS = new Set<string>(CLASS_BOOKING_TAGS);
const positiveInteger = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export const isCourseCapacityBooking = (booking: any): boolean =>
  CLASS_TAGS.has(String(booking?.tag ?? "").toLowerCase());

export const getCourseScheduledCapacity = (booking: any): number | null =>
  positiveInteger(
    booking?.maxNumberOfParticipants ??
      booking?.bookingProduct?.maxNumberOfParticipants,
  );

export const getActiveBookingCapacityHolds = (
  booking: any,
  now = new Date(),
): number =>
  (Array.isArray(booking?.capacityReservations)
    ? booking.capacityReservations
    : []
  ).reduce((total: number, hold: any) => {
    const quantity = positiveInteger(hold?.quantity);
    return quantity && new Date(hold?.expiresAt).getTime() > now.getTime()
      ? total + quantity
      : total;
  }, 0);

/** Reserve all saleable class places, including places not purchased yet. */
export const getBookingCapacityUsed = (booking: any, now = new Date()): number => {
  const course = isCourseCapacityBooking(booking);
  const guests = Math.max(
    course ? 0 : 1,
    Math.floor(Number(booking?.numberOfGuests) || 0),
  );
  const occupied = guests + getActiveBookingCapacityHolds(booking, now);
  if (!course) return occupied;

  const capacity = getCourseScheduledCapacity(booking);
  if (capacity === null) return Number.POSITIVE_INFINITY;
  const waitlistHeld = (Array.isArray(booking?.waitlistCapacityHolds)
    ? booking.waitlistCapacityHolds
    : []
  ).filter(
    (hold: any) => new Date(hold?.expiresAt).getTime() > now.getTime(),
  ).length;
  return Math.max(capacity, occupied + waitlistHeld);
};

/** Unknown class equipment is reserved conservatively in every activity lane. */
export const bookingUsesActivityCapacity = (
  booking: any,
  activity: unknown,
): boolean => {
  const course = isCourseCapacityBooking(booking);
  if (course && booking.courseEquipmentRequired === false) return false;
  return String(booking?.plannedActivity) === String(activity) ||
    (course && (!booking?.plannedActivity || booking.plannedActivity === "UNDEFINED"));
};

/** Attach tenant-scoped product capacity to read-only booking snapshots. */
export const loadCourseCapacityForBookings = async ({
  bookings,
  tenantId,
  session,
}: {
  bookings: any[];
  tenantId: unknown;
  session?: ClientSession | null;
}): Promise<void> => {
  const courses = bookings.filter(isCourseCapacityBooking);
  if (!courses.length) return;
  const ids = [...new Set(
    courses
      .map((booking) => String(booking.bookingProduct?._id ?? booking.bookingProduct ?? ""))
      .filter(Boolean),
  )];
  const products = ids.length
    ? await ProductModel.find({ tenant: tenantId, _id: { $in: ids } })
        .select("_id maxNumberOfParticipants")
        .session(session ?? null)
        .lean()
        .exec()
    : [];
  const capacityById = new Map(
    products.map((product) => [String(product._id), product.maxNumberOfParticipants]),
  );
  for (const booking of courses) {
    booking.maxNumberOfParticipants = positiveInteger(
      capacityById.get(String(booking.bookingProduct?._id ?? booking.bookingProduct)),
    );
  }
};
