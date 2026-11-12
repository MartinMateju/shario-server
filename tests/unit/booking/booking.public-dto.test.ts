import { describe, expect, it } from "vitest";

import {
  serializePublicBookingLocation,
} from "@/modules/booking/booking.public.service.js";

describe("public booking location DTO", () => {
  it("returns only safe booking policy and omits internal or private access", () => {
    const dto = serializePublicBookingLocation({
      _id: "507f1f77bcf86cd799439011",
      name: "Studio Olivka",
      slug: "olivka",
      code: "INTERNAL",
      notes: "staff only",
      isPrimary: true,
      address: { city: "Brno", country: "CZ" },
      contact: { email: "hello@example.test", phone: "+420" },
      booking: {
        enabled: true,
        timezone: "Europe/Prague",
        slotStepMinutes: 30,
        minBookingMinutes: 60,
        maxBookingMinutes: 240,
        globalCapacity: 8,
        allowPublicOverlap: true,
        maxConcurrentOpenStudioBookings: 3,
        activityCapacities: [
          { activity: "WHEEL", capacity: 6 },
        ],
        doorCodeMinutesBefore: 15,
      },
      openingHours: {},
      access: {
        publicInstructions: "Ring the bell.",
        privateInstructions: "Alarm details.",
        doorCode: "1234",
      },
    });
    const serialized = JSON.stringify(dto);

    expect(dto).toMatchObject({
      id: "507f1f77bcf86cd799439011",
      name: "Studio Olivka",
      publicInstructions: "Ring the bell.",
      booking: {
        enabled: true,
        timeZone: "Europe/Prague",
        timezone: "Europe/Prague",
        globalCapacity: 8,
        slotStepMinutes: 30,
        minBookingMinutes: 60,
        maxBookingMinutes: 240,
        allowPublicOverlap: true,
        allowPublicSoloOverlap: true,
        maxConcurrentOpenStudioBookings: 3,
        maxPublicOverlaps: 3,
        maxPublicSoloOverlaps: 3,
        activitySelectionMode: "OPTIONAL",
        activityCapacities: [
          { activity: "WHEEL", capacity: 6 },
        ],
      },
    });
    expect(
      Object.keys(dto.booking).sort(),
    ).toEqual(
      [
        "activityCapacities",
        "activitySelectionMode",
        "allowPublicOverlap",
        "allowPublicSoloOverlap",
        "enabled",
        "globalCapacity",
        "groupBookingBlocksAll",
        "maxConcurrentOpenStudioBookings",
        "maxPublicOverlaps",
        "maxPublicSoloOverlaps",
        "maxBookingMinutes",
        "minBookingMinutes",
        "slotStepMinutes",
        "timeZone",
        "timezone",
      ].sort(),
    );

    for (const forbiddenValue of [
      "1234",
      "Alarm details",
      "staff only",
      "INTERNAL",
    ]) {
      expect(serialized).not.toContain(forbiddenValue);
    }
    expect(serialized).not.toContain("doorCode");
    expect(serialized).not.toContain("privateInstructions");
    expect(serialized).not.toContain("doorCodeMinutesBefore");
  });

  it("preserves an explicitly configured activity-selection mode", () => {
    const dto = serializePublicBookingLocation({
      _id: "507f1f77bcf86cd799439011",
      booking: { activitySelectionMode: "HIDDEN" },
    });

    expect(dto.booking.activitySelectionMode).toBe("HIDDEN");
  });
});
