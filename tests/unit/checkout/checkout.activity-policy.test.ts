import { describe, expect, it } from "vitest";

import { validateWorkshopAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";

const booking = (plannedActivity: string) => ({
  location: "location-1",
  start: new Date("2026-08-20T08:00:00.000Z"),
  end: new Date("2026-08-20T09:00:00.000Z"),
  numberOfGuests: 1,
  bookingMode: "public",
  bookingType: "public",
  plannedActivity,
  tag: "open-studio",
});

const location = (activitySelectionMode?: string) => ({
  _id: "location-1",
  isActive: true,
  booking: {
    enabled: true,
    globalCapacity: 6,
    allowPublicOverlap: true,
    maxConcurrentOpenStudioBookings: 6,
    activitySelectionMode,
    activityCapacities: [{ activity: "WORKSTATION", capacity: 3 }],
  },
});

describe("direct checkout activity policy", () => {
  it("rejects checkout payloads without a required activity", () => {
    expect(() =>
      validateWorkshopAvailabilityOrThrow({
        workshopBookings: [booking("UNDEFINED")],
        currentBookings: [],
        locationById: new Map([["location-1", location("REQUIRED")]]),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BOOKING_ACTIVITY_REQUIRED" }),
    );
  });

  it("canonicalizes hidden checkout activity before persistence", () => {
    const requestedBooking = booking("WORKSTATION");

    expect(
      validateWorkshopAvailabilityOrThrow({
        workshopBookings: [requestedBooking],
        currentBookings: [],
        locationById: new Map([["location-1", location("HIDDEN")]]),
      }),
    ).toBe(true);
    expect(requestedBooking.plannedActivity).toBe("UNDEFINED");
  });

  it("rejects a selected activity not offered by the location", () => {
    expect(() =>
      validateWorkshopAvailabilityOrThrow({
        workshopBookings: [booking("SHARED_TABLE")],
        currentBookings: [],
        locationById: new Map([["location-1", location("OPTIONAL")]]),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BOOKING_ACTIVITY_NOT_AVAILABLE" }),
    );
  });

  it("keeps missing legacy modes optional", () => {
    expect(
      validateWorkshopAvailabilityOrThrow({
        workshopBookings: [booking("UNDEFINED")],
        currentBookings: [],
        locationById: new Map([["location-1", location()]]),
      }),
    ).toBe(true);
  });
});
