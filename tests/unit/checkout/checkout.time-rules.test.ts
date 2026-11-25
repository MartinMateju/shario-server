import { describe, expect, it } from "vitest";

import { validateWorkshopAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";

const now = new Date("2027-01-04T08:00:00.000Z"); // Monday
const openDay = { isOpen: true, openTime: "09:00", closeTime: "18:00" };

const location = (openingHours: Record<string, unknown> = { tuesday: openDay }) => ({
  _id: "location-1",
  isActive: true,
  openingHours,
  booking: {
    enabled: true,
    timezone: "UTC",
    globalCapacity: 6,
    allowPublicOverlap: true,
    maxConcurrentOpenStudioBookings: 6,
    minBookingMinutes: 60,
    maxBookingMinutes: 240,
    slotStepMinutes: 30,
  },
});

const check = (
  start: string,
  end: string,
  options: { enforceTimeRules?: boolean; openingHours?: Record<string, unknown> } = {},
) =>
  validateWorkshopAvailabilityOrThrow({
    workshopBookings: [
      {
        location: "location-1",
        start: new Date(start),
        end: new Date(end),
        numberOfGuests: 1,
        bookingMode: "public",
        bookingType: "public",
        plannedActivity: "UNDEFINED",
        tag: "open-studio",
      },
    ],
    currentBookings: [],
    locationById: new Map([["location-1", location(options.openingHours)]]),
    enforceTimeRules: options.enforceTimeRules ?? true,
    now,
  });

describe("cart checkout time rules for new Open Studio bookings", () => {
  it("accepts a valid future slot inside opening hours", () => {
    expect(check("2027-01-05T10:00:00.000Z", "2027-01-05T12:00:00.000Z")).toBe(
      true,
    );
  });

  it.each([
    ["a past start", "2027-01-03T10:00:00.000Z", "2027-01-03T11:00:00.000Z", "BOOKING_TIME_IN_PAST"],
    ["an end before the start", "2027-01-05T12:00:00.000Z", "2027-01-05T10:00:00.000Z", "BOOKING_TIME_INVALID"],
    ["a duration above the maximum", "2027-01-05T09:00:00.000Z", "2027-01-05T17:00:00.000Z", "BOOKING_DURATION_INVALID"],
    ["an off-grid start", "2027-01-05T10:10:00.000Z", "2027-01-05T11:10:00.000Z", "BOOKING_TIME_STEP_INVALID"],
    ["a closed day", "2027-01-06T10:00:00.000Z", "2027-01-06T11:00:00.000Z", "BOOKING_OUTSIDE_OPENING_HOURS"],
    ["a time before opening", "2027-01-05T07:00:00.000Z", "2027-01-05T08:00:00.000Z", "BOOKING_OUTSIDE_OPENING_HOURS"],
  ])("rejects %s", (_label, start, end, code) => {
    expect(() => check(start, end)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("skips only the opening-hours check when none are configured", () => {
    expect(
      check("2027-01-06T10:00:00.000Z", "2027-01-06T11:00:00.000Z", {
        openingHours: {},
      }),
    ).toBe(true);
    expect(() =>
      check("2027-01-03T10:00:00.000Z", "2027-01-03T11:00:00.000Z", {
        openingHours: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "BOOKING_TIME_IN_PAST" }));
  });

  it("leaves extension segments to the extension service", () => {
    expect(
      check("2027-01-05T12:00:00.000Z", "2027-01-05T12:30:00.000Z", {
        enforceTimeRules: false,
      }),
    ).toBe(true);
  });
});
