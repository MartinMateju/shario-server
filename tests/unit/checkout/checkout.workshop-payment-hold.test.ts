import { describe, expect, it } from "vitest";

import {
  COURSE_RESERVATION_SAFETY_MINUTES,
  STRIPE_CHECKOUT_SESSION_MINUTES,
  WORKSHOP_RESERVATION_GRACE_MINUTES,
} from "@/modules/checkout/checkout.constants.js";
import { isActiveCapacityBooking } from "@/modules/checkout/services/checkout.capacity.service.js";

describe("card workshop payment capacity hold", () => {
  it("remains capacity-active throughout the delayed paid-webhook window", () => {
    expect(WORKSHOP_RESERVATION_GRACE_MINUTES).toBe(
      COURSE_RESERVATION_SAFETY_MINUTES,
    );

    const checkoutStartedAt = new Date("2026-08-04T10:00:00.000Z");
    const sessionExpiresAt = new Date(
      checkoutStartedAt.getTime() + STRIPE_CHECKOUT_SESSION_MINUTES * 60_000,
    );
    const paymentExpiresAt = new Date(
      sessionExpiresAt.getTime() + WORKSHOP_RESERVATION_GRACE_MINUTES * 60_000,
    );
    const pendingWorkshop = {
      tag: "open-studio",
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt,
    };

    expect(
      isActiveCapacityBooking(
        pendingWorkshop,
        new Date(sessionExpiresAt.getTime() + 6 * 60 * 60_000),
      ),
    ).toBe(true);
    expect(
      isActiveCapacityBooking(
        pendingWorkshop,
        new Date(paymentExpiresAt.getTime() + 1),
      ),
    ).toBe(false);
  });
});
