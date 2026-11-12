import { objectId } from "../helpers/objectId.js";

export function buildBookingFixture(overrides = {}) {
  const tenant = overrides.tenant || objectId();
  const createdBy = overrides.createdBy || objectId();
  const start = overrides.start || new Date("2026-07-01T09:00:00.000Z");
  const end = overrides.end || new Date("2026-07-01T10:00:00.000Z");

  return {
    _id: overrides._id || objectId(),
    tenant,
    createdBy,
    start,
    end,
    status: overrides.status || "processed",
    paymentStatus: overrides.paymentStatus || "CONFIRMED",
    tag: overrides.tag || "workshop",
    location: overrides.location || "grohova",
    bookingType: overrides.bookingType || "public",
    numberOfGuests: overrides.numberOfGuests ?? 1,
    numberOfHours: overrides.numberOfHours ?? 1,
    bookingProduct: overrides.bookingProduct || objectId(),
    author: overrides.author || {
      name: "Test User",
      customId: "10001",
    },
    orders: overrides.orders || [],
    participants: overrides.participants || [],
    archive: overrides.archive ?? false,
    ...overrides,
  };
}

export function buildConfirmedWorkshopFixture(overrides = {}) {
  return buildBookingFixture({
    tag: "workshop",
    status: "processed",
    paymentStatus: "CONFIRMED",
    ...overrides,
  });
}

export function buildCourseBookingFixture(overrides = {}) {
  return buildBookingFixture({
    tag: "course",
    bookingType: "course",
    numberOfGuests: overrides.numberOfGuests ?? 8,
    ...overrides,
  });
}
