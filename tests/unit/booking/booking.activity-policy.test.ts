import { describe, expect, it } from "vitest";

import { resolveLocationBookingPlannedActivity } from "@/modules/booking/booking.activity-policy.js";

describe("location booking activity policy", () => {
  it("preserves legacy optional behavior when the mode is missing", () => {
    expect(
      resolveLocationBookingPlannedActivity({
        location: { booking: { activityCapacities: [] } },
        plannedActivity: "UNDEFINED",
      }),
    ).toBe("UNDEFINED");
  });

  it("requires a planned activity in required mode", () => {
    expect(() =>
      resolveLocationBookingPlannedActivity({
        location: {
          booking: {
            activitySelectionMode: "REQUIRED",
            activityCapacities: [{ activity: "WORKSTATION" }],
          },
        },
        plannedActivity: "UNDEFINED",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BOOKING_ACTIVITY_REQUIRED" }),
    );
  });

  it("accepts offered optional activities and rejects unavailable ones", () => {
    const location = {
      booking: {
        activitySelectionMode: "OPTIONAL",
        activityCapacities: [{ activity: "WORKSTATION" }],
      },
    };

    expect(
      resolveLocationBookingPlannedActivity({
        location,
        plannedActivity: "WORKSTATION",
      }),
    ).toBe("WORKSTATION");
    expect(() =>
      resolveLocationBookingPlannedActivity({
        location,
        plannedActivity: "SHARED_TABLE",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BOOKING_ACTIVITY_NOT_AVAILABLE" }),
    );
  });

  it("canonicalizes the activity to undefined when selection is hidden", () => {
    expect(
      resolveLocationBookingPlannedActivity({
        location: {
          booking: {
            activitySelectionMode: "HIDDEN",
            activityCapacities: [{ activity: "WORKSTATION" }],
          },
        },
        plannedActivity: "WORKSTATION",
      }),
    ).toBe("UNDEFINED");
  });
});
