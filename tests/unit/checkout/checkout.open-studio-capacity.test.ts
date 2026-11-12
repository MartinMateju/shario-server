import { describe, expect, it } from "vitest";

import { validateOpenStudioAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";

const locationId = "507f1f77bcf86cd799439011";
const start = new Date("2026-08-03T08:00:00.000Z");
const end = new Date("2026-08-03T09:00:00.000Z");

const locationById = new Map([
  [
    locationId,
    {
      _id: locationId,
      isActive: true,
      booking: {
        enabled: true,
        globalCapacity: 8,
        allowPublicOverlap: true,
        // Canonical value must win over both rollout aliases.
        maxConcurrentOpenStudioBookings: 2,
        maxPublicOverlaps: 1,
        maxPublicSoloOverlaps: 1,
        activityCapacities: [],
      },
    },
  ],
]);

const booking = ({
  bookingMode,
  numberOfGuests,
}: {
  bookingMode: "public" | "private";
  numberOfGuests: number;
}) => ({
  location: locationId,
  start,
  end,
  numberOfGuests,
  bookingMode,
  bookingType: bookingMode,
  plannedActivity: "UNDEFINED",
  tag: "open-studio",
  status: "processed",
  paymentStatus: "CONFIRMED",
});

describe("Open Studio capacity", () => {
  it("keeps a multi-person public reservation public and applies booking and people caps", () => {
    expect(() =>
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          booking({ bookingMode: "public", numberOfGuests: 2 }),
        ],
        currentBookings: [
          booking({ bookingMode: "public", numberOfGuests: 3 }),
        ],
        locationById,
      }),
    ).not.toThrow();

    expect(() =>
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          booking({ bookingMode: "public", numberOfGuests: 1 }),
        ],
        currentBookings: [
          booking({ bookingMode: "public", numberOfGuests: 3 }),
          booking({ bookingMode: "public", numberOfGuests: 2 }),
        ],
        locationById,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }),
    );

    expect(() =>
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          booking({ bookingMode: "public", numberOfGuests: 6 }),
        ],
        currentBookings: [
          booking({ bookingMode: "public", numberOfGuests: 3 }),
        ],
        locationById,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }),
    );
  });

  it("makes private Open Studio exclusive regardless of party size", () => {
    expect(() =>
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          booking({ bookingMode: "private", numberOfGuests: 1 }),
        ],
        currentBookings: [
          booking({ bookingMode: "public", numberOfGuests: 1 }),
        ],
        locationById,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }),
    );

    expect(() =>
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          booking({ bookingMode: "public", numberOfGuests: 1 }),
        ],
        currentBookings: [
          booking({ bookingMode: "private", numberOfGuests: 4 }),
        ],
        locationById,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }),
    );
  });
});
