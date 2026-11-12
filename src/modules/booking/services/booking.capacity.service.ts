import {
  BOOKING_STATUS,
  INTERNAL_STUDIO_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "../booking.constants.js";

type BookingCapacityLike = {
  _id?: unknown;
  start?: string | number | Date;
  end?: string | number | Date;
  status?: string;
  paymentStatus?: string;
  tag?: string;
  location?: unknown;
  numberOfGuests?: number;
};

const sameId = (left: unknown, right: unknown): boolean =>
  String(left ?? "") === String(right ?? "");

const overlaps = (
  left: BookingCapacityLike,
  right: BookingCapacityLike,
): boolean => {
  const leftStart = new Date(left.start as Date).getTime();
  const leftEnd = new Date(left.end as Date).getTime();
  const rightStart = new Date(right.start as Date).getTime();
  const rightEnd = new Date(right.end as Date).getTime();

  return (
    [leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite) &&
    leftStart < rightEnd &&
    leftEnd > rightStart
  );
};

const isCapacityBooking = (booking: BookingCapacityLike): boolean =>
  booking.status !== BOOKING_STATUS.CANCELLED &&
  booking.paymentStatus === PAYMENT_STATUS.CONFIRMED &&
  [...OPEN_STUDIO_BOOKING_TAGS, ...INTERNAL_STUDIO_BOOKING_TAGS].includes(
    booking.tag as never,
  );

export const getNumberOfOverlaps = (
  targetBooking: BookingCapacityLike | null | undefined,
  currentBookings: BookingCapacityLike[],
  locationId: unknown,
): number => {
  if (!targetBooking || !Array.isArray(currentBookings) || !locationId)
    return 0;

  return currentBookings.filter(
    (booking) =>
      isCapacityBooking(booking) &&
      sameId(booking.location, locationId) &&
      (targetBooking._id == null || !sameId(booking._id, targetBooking._id)) &&
      overlaps(targetBooking, booking),
  ).length;
};

export const checkOverlappingCapacity = (
  newBooking: BookingCapacityLike,
  existingBookings: BookingCapacityLike[] = [],
  maxCapacity: number,
) => {
  if (!newBooking?.start || !newBooking?.end || !newBooking.location) {
    return { exceeds: true, maxParticipantsAtTime: 0, conflictingTime: null };
  }

  const newStart = new Date(newBooking.start);
  const newEnd = new Date(newBooking.end);
  const locationId = newBooking.location;
  const safeCapacity = Math.max(1, Math.floor(Number(maxCapacity) || 1));

  const matchingBookings = existingBookings.filter(
    (booking) =>
      isCapacityBooking(booking) &&
      sameId(booking.location, locationId) &&
      overlaps(newBooking, booking),
  );

  let maximumGuests = Math.max(1, Number(newBooking.numberOfGuests) || 1);
  let conflictingTime: Date | null = null;

  for (
    let time = new Date(newStart);
    time < newEnd;
    time = new Date(time.getTime() + 15 * 60 * 1000)
  ) {
    const guestsAtTime = matchingBookings.reduce(
      (total, booking) => {
        const start = new Date(booking.start as Date);
        const end = new Date(booking.end as Date);

        return time >= start && time < end
          ? total + Math.max(1, Number(booking.numberOfGuests) || 1)
          : total;
      },
      Math.max(1, Number(newBooking.numberOfGuests) || 1),
    );

    if (guestsAtTime > maximumGuests) {
      maximumGuests = guestsAtTime;
    }

    if (guestsAtTime > safeCapacity) {
      conflictingTime = new Date(time);
      break;
    }
  }

  return {
    exceeds: conflictingTime !== null,
    maxParticipantsAtTime: maximumGuests,
    conflictingTime,
  };
};
