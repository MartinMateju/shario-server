import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { LocationModel } from "@/modules/location/location.model.js";

describe("location pricing-mode persistence", () => {
  it.each(["time", null] as const)(
    "retains %s through hydration",
    async (pricingMode) => {
      const location = new LocationModel({
        tenant: new mongoose.Types.ObjectId(),
        name: "Studio",
        pricingMode,
      });
      await expect(location.validate()).resolves.toBeUndefined();
      expect(LocationModel.hydrate(location.toObject()).pricingMode).toBe(
        pricingMode,
      );
    },
  );
  it("defaults legacy locations to inheritance and rejects unknown modes", async () => {
    const legacy = new LocationModel({
      tenant: new mongoose.Types.ObjectId(),
      name: "Studio",
    });
    expect(legacy.pricingMode).toBeNull();
    legacy.set("pricingMode", "free");
    await expect(legacy.validate()).rejects.toMatchObject({
      errors: { pricingMode: expect.any(Object) },
    });
  });
});

const buildLocation = (monday: {
  isOpen: boolean;
  openTime: string;
  closeTime: string;
}) =>
  new LocationModel({
    tenant: new mongoose.Types.ObjectId(),
    name: "Studio Emilka",
    openingHours: { monday },
  });

describe("location opening-hours persistence schema", () => {
  it("persists the exact 24:00 closing boundary", async () => {
    const location = buildLocation({
      isOpen: true,
      openTime: "06:00",
      closeTime: "24:00",
    });

    await expect(location.validate()).resolves.toBeUndefined();
  });

  it("rejects a closing boundary after exact 24:00", async () => {
    const location = buildLocation({
      isOpen: true,
      openTime: "06:00",
      closeTime: "24:01",
    });

    await expect(location.validate()).rejects.toMatchObject({
      errors: {
        "openingHours.monday.closeTime": expect.any(Object),
      },
    });
  });

  it("persists an open interval that crosses midnight", async () => {
    const location = buildLocation({
      isOpen: true,
      openTime: "18:00",
      closeTime: "06:00",
    });

    await expect(location.validate()).resolves.toBeUndefined();
  });

  it("retains reverse but well-formed times while the day is closed", async () => {
    const location = buildLocation({
      isOpen: false,
      openTime: "18:00",
      closeTime: "06:00",
    });

    await expect(location.validate()).resolves.toBeUndefined();
  });
});
