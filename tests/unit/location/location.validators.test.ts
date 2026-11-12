import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { locationSchema } from "@/modules/location/location.schema.js";
import { resolveLocationActivitySelectionMode } from "@/modules/location/location.utils.js";
import {
  createLocationSchema,
  updateLocationSchema,
} from "@/modules/location/location.validators.js";

const LOCATION_ID = "64b64c8f4f1c2a3b4c5d6e70";

describe("location pricing-mode override", () => {
  it.each(["time", null] as const)(
    "accepts %s on create and explicit update",
    (pricingMode) => {
      expect(
        createLocationSchema.parse({ name: "Studio", pricingMode }).pricingMode,
      ).toBe(pricingMode);
      expect(
        updateLocationSchema.parse({ id: LOCATION_ID, pricingMode })
          .pricingMode,
      ).toBe(pricingMode);
    },
  );
  it("keeps omitted updates untouched and rejects invalid overrides", () => {
    expect(
      updateLocationSchema.parse({ id: LOCATION_ID, name: "Renamed" }),
    ).not.toHaveProperty("pricingMode");
    for (const pricingMode of ["", "all", false, 1, {}])
      expect(
        updateLocationSchema.safeParse({ id: LOCATION_ID, pricingMode })
          .success,
      ).toBe(false);
  });
});

const parseHours = (monday: {
  isOpen: boolean;
  openTime: string;
  closeTime: string;
}) =>
  updateLocationSchema.safeParse({
    id: LOCATION_ID,
    openingHours: { monday },
  });

describe("location opening-hours validation", () => {
  it("accepts midnight only as the exact 24:00 closing boundary", () => {
    expect(
      parseHours({
        isOpen: true,
        openTime: "06:00",
        closeTime: "24:00",
      }).success,
    ).toBe(true);

    const result = parseHours({
      isOpen: true,
      openTime: "06:00",
      closeTime: "24:01",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["openingHours", "monday", "closeTime"],
            message: "Invalid close time.",
          }),
        ]),
      );
    }
  });

  it("accepts an open interval that crosses midnight", () => {
    expect(
      parseHours({
        isOpen: true,
        openTime: "18:00",
        closeTime: "06:00",
      }).success,
    ).toBe(true);
  });

  it("keeps valid stored times on a closed day without enforcing their order", () => {
    expect(
      parseHours({
        isOpen: false,
        openTime: "18:00",
        closeTime: "06:00",
      }).success,
    ).toBe(true);
  });

  it("validates a complete seven-day editor payload", () => {
    const openingHours = Object.fromEntries(
      [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ].map((day) => [
        day,
        { isOpen: true, openTime: "06:00", closeTime: "24:00" },
      ]),
    );

    expect(
      updateLocationSchema.safeParse({
        id: LOCATION_ID,
        openingHours,
      }).success,
    ).toBe(true);
  });
});

describe("location activity-selection validation", () => {
  it("keeps booking duration validation when a partial update omits section defaults", () => {
    const booking = { minBookingMinutes: 120, maxBookingMinutes: 60 };
    expect(
      createLocationSchema.safeParse({ name: "Studio", booking }).success,
    ).toBe(false);
    const update = updateLocationSchema.safeParse({ id: LOCATION_ID, booking });
    expect(update.success).toBe(false);
    if (!update.success) {
      expect(update.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["booking", "maxBookingMinutes"] }),
        ]),
      );
    }
  });
  it.each([0, -1, 1.5, 3651, "invalid"])(
    "rejects invalid firing deadline %s",
    (days) => {
      expect(
        updateLocationSchema.safeParse({
          id: LOCATION_ID,
          firingSettings: { glazingDeadlineDays: days },
        }).success,
      ).toBe(false);
    },
  );
  it("defaults newly-created locations to required activity selection", () => {
    const result = createLocationSchema.parse({ name: "Main studio" });

    expect(result.booking.activitySelectionMode).toBe("REQUIRED");
  });

  it.each(["REQUIRED", "OPTIONAL", "HIDDEN"] as const)(
    "accepts the %s activity-selection mode",
    (activitySelectionMode) => {
      expect(
        updateLocationSchema.safeParse({
          id: LOCATION_ID,
          booking: { activitySelectionMode },
        }).success,
      ).toBe(true);
    },
  );

  it("rejects an unknown activity-selection mode", () => {
    const result = updateLocationSchema.safeParse({
      id: LOCATION_ID,
      booking: { activitySelectionMode: "SOMETIMES" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["booking", "activitySelectionMode"],
          }),
        ]),
      );
    }
  });

  it("defaults new model instances without changing hydrated legacy records", () => {
    const Location =
      mongoose.models.LocationActivitySelectionTest ??
      mongoose.model("LocationActivitySelectionTest", locationSchema);

    expect(
      new Location({ name: "New studio" }).booking.activitySelectionMode,
    ).toBe("REQUIRED");
    expect(
      Location.hydrate({ name: "Legacy studio", booking: {} }).booking
        .activitySelectionMode,
    ).toBeUndefined();
  });

  it("resolves missing legacy values as optional and invalid values safely", () => {
    expect(resolveLocationActivitySelectionMode(undefined)).toBe("OPTIONAL");
    expect(resolveLocationActivitySelectionMode("INVALID")).toBe("REQUIRED");
  });
});
