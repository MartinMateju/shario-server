import { describe, expect, it } from "vitest";

import { getBookingCapacityUsed } from "@/modules/booking/booking.course-capacity.js";
import { calculateOpenStudioRemainingCapacity, serializeCustomerAvailabilityBooking, serializePublicBookingLocation } from "@/modules/booking/booking.public.service.js";
import { validateOpenStudioAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";

const locationId = "507f1f77bcf86cd799439011";
const start = new Date("2030-01-07T10:00:00.000Z");
const end = new Date("2030-01-07T11:00:00.000Z");
const location = {
  _id: locationId,
  isActive: true,
  booking: {
    enabled: true,
    globalCapacity: 14,
    allowPublicSoloOverlap: true,
    maxPublicSoloOverlaps: 1,
    groupBookingBlocksAll: false,
    privateSessionBlocksAll: false,
    activityCapacities: [
      { activity: "WORKSTATION", capacity: 6 },
      { activity: "SHARED_TABLE", capacity: 8 },
    ],
  },
};
const course = {
  location: locationId, start, end, tag: "course", status: "processed",
  paymentStatus: "CONFIRMED", bookingMode: "private", bookingType: "private",
  plannedActivity: "SHARED_TABLE", numberOfGuests: 2,
  maxNumberOfParticipants: 8,
};
const request = {
  location: locationId, start, end, tag: "open-studio", status: "processed",
  paymentStatus: "CONFIRMED", bookingMode: "public", bookingType: "public",
  plannedActivity: "WORKSTATION", numberOfGuests: 6,
};
const validate = (existing: any[] = [course], requested: any = request, studio: any = location) =>
  validateOpenStudioAvailabilityOrThrow({
    openStudioBookings: [requested], currentBookings: existing,
    locationById: new Map([[locationId, studio]]),
  });

describe("courses sharing studio capacity", () => {
  it("reserves all eight class places and leaves six global/wheel places without using a studio booking lane", () => {
    expect(() => validate()).not.toThrow();
    expect(() => validate([course], { ...request, numberOfGuests: 7 })).toThrowError(
      expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }),
    );
    expect(calculateOpenStudioRemainingCapacity({
      location, bookings: [course], start, end, productCapacity: 14,
      publicCapacityLimit: null, customerChoiceBooking: false,
      bookingMode: "public", plannedActivity: "WORKSTATION", available: true,
    })).toEqual({ remainingCapacity: 6, remainingBookings: 1 });
    expect(() => validate([course], request, {
      ...location, booking: { ...location.booking, allowPublicSoloOverlap: false },
    })).not.toThrow();
  });

  it("keeps private closures exclusive even with both location flags false", () => {
    expect(() => validate([{ ...course, tag: "private-session" }])).toThrowError(
      expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }),
    );
  });

  it.each([true, undefined])("blocks courses where the location group flag is %s", (flag) => {
    expect(() => validate([course], request, {
      ...location, booking: { ...location.booking, groupBookingBlocksAll: flag },
    })).toThrowError(expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }));
  });

  it("reserves known course equipment and conservatively reserves every lane for unknown equipment", () => {
    expect(() => validate([course], { ...request, numberOfGuests: 1, plannedActivity: "SHARED_TABLE" })).toThrowError(
      expect.objectContaining({ code: "LOCATION_ACTIVITY_CAPACITY_EXCEEDED" }),
    );
    for (const activity of ["WORKSTATION", "SHARED_TABLE"]) {
      expect(() => validate([{ ...course, plannedActivity: "UNDEFINED" }], {
        ...request, numberOfGuests: 1, plannedActivity: activity,
      })).toThrowError(expect.objectContaining({ code: "LOCATION_ACTIVITY_CAPACITY_EXCEEDED" }));
    }
  });

  it("reserves global places but no equipment only for a class explicitly marked as using none", () => {
    const equipmentFree = {
      ...course, maxNumberOfParticipants: 5, plannedActivity: "UNDEFINED", courseEquipmentRequired: false,
    };
    for (const [activity, guests] of [["WORKSTATION", 6], ["SHARED_TABLE", 8]] as const) {
      expect(() => validate([equipmentFree], { ...request, plannedActivity: activity, numberOfGuests: guests })).not.toThrow();
    }
    expect(() => validate([equipmentFree], { ...request, plannedActivity: "UNDEFINED", numberOfGuests: 10 })).toThrowError(
      expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }),
    );
    expect(serializeCustomerAvailabilityBooking(equipmentFree)).toMatchObject({
      capacityUsed: 5, courseEquipmentRequired: false,
    });
    expect(() => validate([{ ...equipmentFree, tag: "private-session" }])).toThrowError(
      expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }),
    );
    expect(() => validate([{ ...request, courseEquipmentRequired: false }], {
      ...request, numberOfGuests: 1,
    }, { ...location, booking: { ...location.booking, maxPublicSoloOverlaps: 2 } })).toThrowError(
      expect.objectContaining({ code: "LOCATION_ACTIVITY_CAPACITY_EXCEEDED" }),
    );
  });

  it.each([
    { status: "cancelled" }, { status: "canceled" }, { archive: true },
    { paymentStatus: "FAILED" },
    { paymentStatus: "PENDING_PAYMENT", paymentExpiresAt: new Date(0) },
  ])("ignores inactive classes: %j", (inactive) => {
    expect(() => validate([{ ...course, ...inactive }], { ...request, plannedActivity: "SHARED_TABLE", numberOfGuests: 8 })).not.toThrow();
  });

  it("counts live checkout and waitlist holds, ignores expired holds and does not use participant-array length", () => {
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    const held = {
      ...course, numberOfGuests: 6, participants: Array(20).fill({}),
      capacityReservations: [{ quantity: 2, expiresAt: future }, { quantity: 50, expiresAt: new Date(0) }],
      waitlistCapacityHolds: [{ expiresAt: future }, { expiresAt: new Date(0) }],
    };
    expect(getBookingCapacityUsed(held, now)).toBe(9);
    expect(() => validate([held])).toThrowError(expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }));
    expect(serializeCustomerAvailabilityBooking(held)).toMatchObject({
      participantCount: 6, capacityUsed: 9, maxNumberOfParticipants: 8, courseCapacityUnavailable: false,
    });
    expect(JSON.stringify(serializeCustomerAvailabilityBooking(held))).not.toContain("capacityReservations");
    expect(() => validate([{ ...course, paymentStatus: "PENDING_PAYMENT", paymentExpiresAt: future }])).not.toThrow();
  });

  it("blocks unknown class capacity and exposes only a safe missing-capacity sentinel", () => {
    const missing = { ...course, maxNumberOfParticipants: null };
    expect(() => validate([missing])).toThrowError(expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }));
    expect(serializeCustomerAvailabilityBooking(missing)).toMatchObject({
      maxNumberOfParticipants: null, capacityUsed: null, courseCapacityUnavailable: true,
    });
    expect(serializePublicBookingLocation(location).booking.groupBookingBlocksAll).toBe(false);
    expect(serializePublicBookingLocation({ _id: locationId }).booking.groupBookingBlocksAll).toBe(true);
  });
});
