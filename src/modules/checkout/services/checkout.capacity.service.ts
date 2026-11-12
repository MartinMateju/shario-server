import { resolveLocationBookingPlannedActivity } from "@/modules/booking/booking.activity-policy.js";
import {
  bookingUsesActivityCapacity,
  getBookingCapacityUsed,
  getCourseScheduledCapacity,
  isCourseCapacityBooking,
} from "@/modules/booking/booking.course-capacity.js";
import { MAX_COURSE_PARTICIPANTS_PER_ITEM } from "@/modules/checkout/checkout.constants.js";
import { MAX_PRODUCT_PARTICIPANTS } from "@/modules/product/product.constants.js";
import { AppError, badRequest, conflict } from "@/shared/http/httpErrors.js";

const OPEN_STUDIO_TAGS = new Set(["open-studio", "workshop", "extension-hold"]);
const INTERNAL_STUDIO_TAGS = new Set(["private-studio", "private-session"]);

const sameId = (left, right) => String(left ?? "") === String(right ?? "");

const toTimestamp = (value) => new Date(value).getTime();

const overlaps = (left, right) => {
  const leftStart = toTimestamp(left.start);
  const leftEnd = toTimestamp(left.end);
  const rightStart = toTimestamp(right.start);
  const rightEnd = toTimestamp(right.end);

  return (
    [leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite) &&
    leftStart < rightEnd &&
    leftEnd > rightStart
  );
};

export const isActiveCapacityBooking = (booking, now = new Date()) => {
  const status = String(booking?.status || "").toLowerCase();
  const paymentStatus = String(booking?.paymentStatus || "").toUpperCase();
  const tag = String(booking?.tag || "").toLowerCase();
  const pendingUntil = new Date(booking?.paymentExpiresAt).getTime();
  const isConfirmed = !paymentStatus || paymentStatus === "CONFIRMED";
  const isUnexpiredPending =
    paymentStatus === "PENDING_PAYMENT" &&
    Number.isFinite(pendingUntil) &&
    pendingUntil > now.getTime();

  return (
    !["cancelled", "canceled"].includes(status) &&
    booking?.archive !== true &&
    (isConfirmed || isUnexpiredPending) &&
    (OPEN_STUDIO_TAGS.has(tag) ||
      INTERNAL_STUDIO_TAGS.has(tag) ||
      isCourseCapacityBooking(booking))
  );
};

const getGuests = getBookingCapacityUsed;

const getBookingType = (booking, config) => {
  // Scheduled class modes predate sharing policy. Only an explicit location
  // opt-in permits sharing, and a missing class capacity must remain blocking.
  if (isCourseCapacityBooking(booking)) {
    return config.groupBookingBlocksAll === false && getCourseScheduledCapacity(booking) !== null
      ? "public"
      : "private";
  }
  return String(
    booking?.bookingMode ?? booking?.bookingType ?? "private",
  ).toLowerCase() === "public"
    ? "public"
    : "private";
};

const getActivityCapacity = (location, activity) => {
  if (!activity || activity === "UNDEFINED") return null;

  const match = (location?.booking?.activityCapacities || []).find(
    (item) => String(item.activity) === String(activity),
  );

  return match ? Math.max(1, Number(match.capacity) || 1) : null;
};

const availabilityError = ({ message, code, locationId }) =>
  new AppError({
    message,
    statusCode: 409,
    code,
    details: { locationId: String(locationId) },
  });

// Occupancy changes only when a reservation starts or ends. Sampling the
// requested start and subsequent starts avoids counting adjacent sessions
// together when a longer booking spans both.
export const getConcurrentBookingSnapshots = ({ booking, bookings }) => {
  const active = bookings.filter(
    (candidate) =>
      isActiveCapacityBooking(candidate) &&
      sameId(candidate.location, booking.location) &&
      overlaps(candidate, booking),
  );
  const start = toTimestamp(booking.start);
  const end = toTimestamp(booking.end);
  const points = new Set([
    start,
    ...active
      .map((candidate) => toTimestamp(candidate.start))
      .filter((point) => point > start && point < end),
  ]);
  return [...points].map((point) =>
    active.filter(
      (candidate) =>
        toTimestamp(candidate.start) <= point && toTimestamp(candidate.end) > point,
    ),
  );
};

const validateOneBookingAtTime = ({ booking, acceptedBookings, location }) => {
  const locationId = booking.location;
  const config = location.booking || {};
  const overlappingBookings = acceptedBookings.filter(
    (candidate) =>
      isActiveCapacityBooking(candidate) &&
      sameId(candidate.location, locationId) &&
      overlaps(candidate, booking),
  );

  const requestedGuests = getGuests(booking);
  const requestedType = getBookingType(booking, config);
  const requestedPrivateSession = INTERNAL_STUDIO_TAGS.has(
    String(booking.tag).toLowerCase(),
  );
  const hasPrivateSession = overlappingBookings.some((candidate) =>
    INTERNAL_STUDIO_TAGS.has(String(candidate.tag).toLowerCase()),
  );

  if (
    overlappingBookings.length > 0 &&
    (hasPrivateSession || requestedPrivateSession)
  ) {
    throw availabilityError({
      message: "The selected time is no longer available at this location.",
      code: "LOCATION_OVERLAP_NOT_ALLOWED",
      locationId,
    });
  }

  const isPublic = requestedType === "public";
  const allExistingPublic = overlappingBookings.every(
    (candidate) => getBookingType(candidate, config) === "public",
  );
  const overlappingOpenStudioBookings = overlappingBookings.filter(
    (candidate) => !isCourseCapacityBooking(candidate),
  );

  if (overlappingOpenStudioBookings.length > 0 && isPublic && allExistingPublic) {
    const allowPublicOverlap =
      config.allowPublicOverlap ?? config.allowPublicSoloOverlap;

    if (!allowPublicOverlap) {
      throw availabilityError({
        message: "The selected time is no longer available at this location.",
        code: "LOCATION_OVERLAP_NOT_ALLOWED",
        locationId,
      });
    }

    const overlapLimit = Math.max(
      1,
      Number(
        config.maxConcurrentOpenStudioBookings ??
          config.maxPublicOverlaps ??
          config.maxPublicSoloOverlaps,
      ) || 1,
    );

    if (overlappingOpenStudioBookings.length + 1 > overlapLimit) {
      throw availabilityError({
        message: "The selected time has reached its booking limit.",
        code: "LOCATION_CAPACITY_EXCEEDED",
        locationId,
      });
    }
  }

  const hasPrivateBooking = overlappingBookings.some(
    (candidate) => getBookingType(candidate, config) === "private",
  );

  if (
    overlappingBookings.length > 0 &&
    (requestedType === "private" || hasPrivateBooking)
  ) {
    throw availabilityError({
      message: "The selected time is no longer available at this location.",
      code: "LOCATION_OVERLAP_NOT_ALLOWED",
      locationId,
    });
  }

  const totalGuests = overlappingBookings.reduce(
    (total, candidate) => total + getGuests(candidate),
    requestedGuests,
  );
  const globalCapacity = Math.max(1, Number(config.globalCapacity) || 1);

  // A limit belongs to the whole shared session, including its original
  // customer and their guests. Respect every overlapping booking's snapshot
  // so a different product or a later product edit cannot bypass that promise.
  const publicLimits = isPublic
    ? [booking, ...overlappingBookings]
        .filter((candidate) => !isCourseCapacityBooking(candidate))
        .map((candidate) => Number(candidate.publicCapacityLimit))
        .filter((limit) => Number.isSafeInteger(limit) && limit > 0)
    : [];
  if (publicLimits.length && totalGuests > Math.min(...publicLimits)) {
    throw availabilityError({
      message: "The public session has reached its total participant limit.",
      code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED",
      locationId,
    });
  }

  if (totalGuests > globalCapacity) {
    throw availabilityError({
      message: "The selected time has reached this location's capacity.",
      code: "LOCATION_CAPACITY_EXCEEDED",
      locationId,
    });
  }

  const activityCapacity = getActivityCapacity(
    location,
    booking.plannedActivity,
  );

  if (
    activityCapacity &&
    !(requestedType === "private" && booking.customerChoiceBooking === true)
  ) {
    const matchingActivityGuests = overlappingBookings
      .filter(
        (candidate) =>
          bookingUsesActivityCapacity(candidate, booking.plannedActivity),
      )
      .reduce(
        (total, candidate) => total + getGuests(candidate),
        requestedGuests,
      );

    if (matchingActivityGuests > activityCapacity) {
      throw availabilityError({
        message: "The selected activity has reached its capacity.",
        code: "LOCATION_ACTIVITY_CAPACITY_EXCEEDED",
        locationId,
      });
    }
  }
};

const validateOneBooking = ({ booking, acceptedBookings, location }) => {
  for (const snapshot of getConcurrentBookingSnapshots({
    booking,
    bookings: acceptedBookings,
  })) {
    validateOneBookingAtTime({ booking, acceptedBookings: snapshot, location });
  }
};

export const validateOpenStudioAvailabilityOrThrow = ({
  openStudioBookings = undefined,
  workshopBookings = undefined,
  currentBookings = [],
  locationById,
}) => {
  const acceptedBookings = [...(currentBookings || [])];
  const requestedBookings = openStudioBookings ?? workshopBookings ?? [];

  for (const booking of requestedBookings) {
    const location = locationById.get(String(booking.location));

    if (!location?.isActive || !location?.booking?.enabled) {
      throw availabilityError({
        message: "The selected studio location is unavailable.",
        code: "LOCATION_NOT_AVAILABLE",
        locationId: booking.location,
      });
    }

    validateOneBooking({ booking, acceptedBookings, location });
    acceptedBookings.push(booking);
  }

  return true;
};

/**
 * Direct checkout still uses the historical workshop-named entry point. Keep
 * the customer activity-selection invariant here as well as in booking
 * intents, then delegate all capacity checks to the canonical validator.
 *
 * @deprecated Use validateOpenStudioAvailabilityOrThrow for non-checkout use.
 */
export const validateWorkshopAvailabilityOrThrow = ({
  workshopBookings = undefined,
  openStudioBookings = undefined,
  currentBookings = [],
  locationById,
}) => {
  const requestedBookings = openStudioBookings ?? workshopBookings ?? [];

  for (const booking of requestedBookings) {
    const location = locationById.get(String(booking.location));
    if (!location) continue;

    booking.plannedActivity = resolveLocationBookingPlannedActivity({
      location,
      plannedActivity: booking.plannedActivity,
    });
  }

  return validateOpenStudioAvailabilityOrThrow({
    openStudioBookings: requestedBookings,
    currentBookings,
    locationById,
  });
};

export const getCourseCapacity = (product): number => {
  const configured = Number(product?.maxNumberOfParticipants);

  if (product?.maxNumberOfParticipants == null) {
    badRequest({
      message:
        "The selected Class does not have a participant capacity configured.",
      code: "CHECKOUT_COURSE_CAPACITY_NOT_CONFIGURED",
      details: { productId: String(product?._id || "") },
    });
  }

  if (
    !Number.isSafeInteger(configured) ||
    configured < 1 ||
    configured > MAX_PRODUCT_PARTICIPANTS
  ) {
    badRequest({
      message: "The selected Class has an invalid capacity configuration.",
      code: "CHECKOUT_COURSE_CAPACITY_INVALID",
      details: { productId: String(product?._id || "") },
    });
  }

  return configured;
};

/**
 * Validates every course intent against tenant-scoped DB records. The service
 * supplies slots loaded through `findCourseSlots({ tenantId, ... })`; a slot
 * absent from that result is therefore unavailable to this tenant.
 */
export const validateCourseAvailabilityOrThrow = ({
  courseBookings = [],
  slots = [],
  productById,
  mustStartAfter = undefined,
}) => {
  if (!courseBookings.length) return true;

  const slotById = new Map(slots.map((slot) => [String(slot._id), slot]));

  for (const requested of courseBookings) {
    const slotId = String(requested.bookingId);
    const productId = String(requested.productId);
    const slot = slotById.get(slotId);
    const product = productById?.get(productId);

    if (!slot) {
      badRequest({
        message: "The selected Class session is unavailable.",
        code: "CHECKOUT_COURSE_SLOT_INVALID",
        details: { bookingId: slotId },
      });
    }

    if (!product || !sameId(slot.bookingProduct, productId)) {
      badRequest({
        message: "The selected Class session does not belong to this product.",
        code: "CHECKOUT_COURSE_PRODUCT_MISMATCH",
        details: {
          bookingId: slotId,
          requestedProductId: productId,
        },
      });
    }

    if (mustStartAfter) {
      const slotStart = new Date(slot.start).getTime();
      const paymentDeadline = new Date(mustStartAfter).getTime();

      if (
        !Number.isFinite(slotStart) ||
        !Number.isFinite(paymentDeadline) ||
        slotStart <= paymentDeadline
      ) {
        conflict({
          message:
            "This Class starts too soon to complete an online payment safely.",
          code: "CHECKOUT_COURSE_START_TOO_SOON",
          details: {
            bookingId: slotId,
            startsAt: slot.start,
            paymentDeadline: mustStartAfter,
          },
        });
      }
    }

    const requestedParticipants = Number(requested.quantity);

    if (
      !Number.isSafeInteger(requestedParticipants) ||
      requestedParticipants < 1 ||
      requestedParticipants > MAX_COURSE_PARTICIPANTS_PER_ITEM
    ) {
      badRequest({
        message: "Class participant quantity is invalid.",
        code: "CHECKOUT_COURSE_QUANTITY_INVALID",
      });
    }

    const occupied = Number(slot.numberOfGuests ?? 0);

    if (!Number.isSafeInteger(occupied) || occupied < 0) {
      badRequest({
        message: "The selected Class session has invalid availability data.",
        code: "CHECKOUT_COURSE_CAPACITY_INVALID",
        details: { bookingId: slotId },
      });
    }

    const capacity = getCourseCapacity(product);
    const available = Math.max(0, capacity - occupied);

    if (requestedParticipants > available) {
      conflict({
        message: "The selected Class no longer has enough available places.",
        code: "CHECKOUT_COURSE_CAPACITY_EXCEEDED",
        details: {
          bookingId: slotId,
          capacity,
          occupied,
          requested: requestedParticipants,
          available,
        },
      });
    }
  }

  return true;
};

export const validateGuestIncreaseAvailabilityOrThrow = ({
  guestIncreaseBookings = [],
  targets = [],
  userId,
  currentBookings = [],
  locationById,
  reservationOrderId = undefined,
}) => {
  if (!guestIncreaseBookings.length) return true;

  // An idempotent checkout retry can encounter the capacity hold created by
  // its previous attempt. Exclude only that order's hold from preflight so it
  // is not counted once as reserved capacity and again as the requested
  // increase. Holds belonging to every other checkout still count normally.
  const withoutOwnReservation = (booking) =>
    reservationOrderId
      ? {
          ...booking,
          capacityReservations: (Array.isArray(booking?.capacityReservations)
            ? booking.capacityReservations
            : []
          ).filter(
            (reservation) => !sameId(reservation?.order, reservationOrderId),
          ),
        }
      : booking;

  const effectiveTargets = targets.map(withoutOwnReservation);
  const effectiveCurrentBookings = currentBookings.map(withoutOwnReservation);

  const targetById = new Map(
    effectiveTargets.map((target) => [String(target._id), target]),
  );
  const simulatedById = new Map();

  for (const operation of guestIncreaseBookings) {
    const bookingId = String(operation.bookingId);
    const target = targetById.get(bookingId);

    if (!target) {
      badRequest({
        message: "The selected Open Studio booking is unavailable.",
        code: "CHECKOUT_GUEST_INCREASE_BOOKING_INVALID",
        details: { bookingId },
      });
    }

    if (!sameId(target.createdBy, userId)) {
      badRequest({
        message: "Guests may only be added to your own Open Studio booking.",
        code: "CHECKOUT_GUEST_INCREASE_NOT_OWNED",
        details: { bookingId },
      });
    }

    if (
      String(target.status || "").toLowerCase() === "cancelled" ||
      String(target.paymentStatus || "").toUpperCase() !== "CONFIRMED" ||
      new Date(target.start).getTime() <= Date.now()
    ) {
      badRequest({
        message: "Guests cannot be added to this Open Studio booking.",
        code: "CHECKOUT_GUEST_INCREASE_BOOKING_UNAVAILABLE",
        details: { bookingId },
      });
    }

    const start = new Date(target.start).getTime();
    const end = new Date(target.end).getTime();
    const serverBillingBlocks = Math.ceil((end - start) / (30 * 60 * 1000));

    if (
      !Number.isSafeInteger(serverBillingBlocks) ||
      serverBillingBlocks < 1 ||
      operation.billingBlocks !== serverBillingBlocks
    ) {
      badRequest({
        message:
          "Guest increase price does not match the Open Studio duration.",
        code: "CHECKOUT_GUEST_INCREASE_DURATION_MISMATCH",
        details: {
          bookingId,
          expectedBlocks: serverBillingBlocks,
          suppliedBlocks: operation.billingBlocks,
        },
      });
    }

    const currentGuests = Number(target.numberOfGuests ?? 1);

    if (!Number.isSafeInteger(currentGuests) || currentGuests < 1) {
      badRequest({
        message: "The Open Studio booking has invalid capacity data.",
        code: "CHECKOUT_GUEST_INCREASE_CAPACITY_INVALID",
        details: { bookingId },
      });
    }

    const previousSimulation = simulatedById.get(bookingId);
    simulatedById.set(bookingId, {
      ...target,
      numberOfGuests:
        Number(previousSimulation?.numberOfGuests ?? currentGuests) +
        operation.addGuests,
    });
  }

  // Validate the final combined snapshot. Validating each increase against
  // the original booking list independently lets two overlapping target
  // bookings each consume the same last place. Replace every target with its
  // fully increased version before evaluating any of them.
  const finalBookings = effectiveCurrentBookings.map(
    (booking) => simulatedById.get(String(booking._id)) ?? booking,
  );
  const snapshotIds = new Set(
    finalBookings.map((booking) => String(booking._id)),
  );

  for (const [bookingId, simulatedBooking] of simulatedById) {
    if (!snapshotIds.has(bookingId)) {
      finalBookings.push(simulatedBooking);
      snapshotIds.add(bookingId);
    }
  }

  for (const simulatedBooking of simulatedById.values()) {
    const otherBookings = finalBookings.filter(
      (booking) => !sameId(booking._id, simulatedBooking._id),
    );
    const location = locationById.get(String(simulatedBooking.location));

    if (!location?.isActive || !location?.booking?.enabled) {
      throw availabilityError({
        message: "The selected studio location is unavailable.",
        code: "LOCATION_NOT_AVAILABLE",
        locationId: simulatedBooking.location,
      });
    }

    validateOneBooking({
      booking: simulatedBooking,
      acceptedBookings: otherBookings,
      location,
    });
  }

  return true;
};
