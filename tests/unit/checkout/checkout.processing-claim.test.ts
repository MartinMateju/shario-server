import { describe, expect, it } from "vitest";

import {
  buildStripeOrderLeaseAvailabilityFilter,
  getStripeOrderLeaseExpiry,
  STRIPE_ORDER_PROCESSING_LEASE_MS,
} from "@/modules/checkout/checkout.processing-claim.js";

describe("Stripe order processing claim", () => {
  it("can claim only an unowned or expired order lease", () => {
    const now = new Date("2026-07-21T10:00:00.000Z");

    expect(buildStripeOrderLeaseAvailabilityFilter(now)).toEqual({
      $or: [
        { "stripe.processingClaimToken": { $exists: false } },
        { "stripe.processingClaimToken": "" },
        { "stripe.processingLeaseExpiresAt": null },
        { "stripe.processingLeaseExpiresAt": { $lte: now } },
      ],
    });
  });

  it("creates a bounded recovery lease", () => {
    const now = new Date("2026-07-21T10:00:00.000Z");
    const expiry = getStripeOrderLeaseExpiry(now);

    expect(expiry.getTime() - now.getTime()).toBe(
      STRIPE_ORDER_PROCESSING_LEASE_MS,
    );
    expect(expiry).not.toBe(now);
  });
});
