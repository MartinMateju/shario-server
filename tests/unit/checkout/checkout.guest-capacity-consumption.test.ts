import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { buildGuestIncreaseCapacityHoldRequirement } from "@/modules/checkout/checkout.guest-capacity-hold.js";

describe("guest-increase hold consumption", () => {
  it("requires the paid order's hold to still be unexpired", () => {
    const orderId = new mongoose.Types.ObjectId();
    const now = new Date("2026-08-04T12:00:00.000Z");
    const requirement = buildGuestIncreaseCapacityHoldRequirement({
      orderId,
      addGuests: 2,
      capacityReserved: true,
      now,
    });

    expect(requirement).toEqual({
      capacityReservations: {
        $elemMatch: {
          order: orderId,
          quantity: 2,
          expiresAt: { $gt: now },
        },
      },
    });
    expect(
      new Date("2026-08-04T11:59:59.999Z") >
        requirement.capacityReservations.$elemMatch.expiresAt.$gt,
    ).toBe(false);
  });

  it("keeps pre-deployment orders fulfillable during the rollout window", () => {
    expect(
      buildGuestIncreaseCapacityHoldRequirement({
        orderId: new mongoose.Types.ObjectId(),
        addGuests: 1,
        capacityReserved: false,
      }),
    ).toEqual({});
  });
});
