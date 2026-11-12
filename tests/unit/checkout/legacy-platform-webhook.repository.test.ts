import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";
import { Order } from "@/modules/order/order.model.js";

const emptyConnectedAccountClause = {
  $or: [
    { "stripe.connectedAccountId": { $exists: false } },
    { "stripe.connectedAccountId": "" },
    { "stripe.connectedAccountId": null },
  ],
};

const emptyVoucherConnectedAccountClause = {
  $or: [
    { stripeConnectedAccountId: { $exists: false } },
    { stripeConnectedAccountId: "" },
    { stripeConnectedAccountId: null },
  ],
};

describe("legacy platform webhook repository guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("atomically excludes Connect-owned orders from the payment claim", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const exec = vi.fn().mockResolvedValue(null);
    const findOneAndUpdate = vi
      .spyOn(Order, "findOneAndUpdate")
      .mockReturnValue(
        { lean: vi.fn().mockReturnValue({ exec }) } as never,
      );

    await checkoutRepository.claimLegacyPlatformStripeOrder({
      tenantId,
      orderId,
      eventId: "evt_legacy",
      claimToken: "claim_legacy",
      now: new Date("2026-07-22T10:00:00.000Z"),
      leaseExpiresAt: new Date("2026-07-22T10:10:00.000Z"),
      session: {
        id: "cs_legacy",
        payment_intent: "pi_legacy",
        currency: "CZK",
        amount_total: 2_500,
        livemode: false,
      },
    });

    const filter = findOneAndUpdate.mock.calls[0][0] as unknown as {
      tenant: mongoose.Types.ObjectId;
      $and: unknown[];
    };
    expect(filter.tenant).toEqual(tenantId);
    expect(filter.$and).toEqual(
      expect.arrayContaining([
        { _id: orderId },
        { "stripe.sessionId": "cs_legacy" },
        emptyConnectedAccountClause,
        {
          $or: [
            { "stripe.livemode": { $exists: false } },
            { "stripe.livemode": null },
            { "stripe.livemode": false },
          ],
        },
      ]),
    );
  });

  it("atomically excludes Connect-owned voucher orders before fulfillment", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const couponOrderId = new mongoose.Types.ObjectId();
    const updateOne = vi
      .spyOn(CouponOrder, "updateOne")
      .mockReturnValue(
        { exec: vi.fn().mockResolvedValue({ matchedCount: 1 }) } as never,
      );

    await couponRepository.bindLegacyPlatformCouponOrderSnapshot({
      tenantId: String(tenantId),
      couponOrderId: String(couponOrderId),
      sessionId: "cs_legacy_voucher",
      currency: "CZK",
      storedExpectedAmountMinor: 5_000,
      livemode: false,
    });

    const filter = updateOne.mock.calls[0][0] as unknown as {
      $and: unknown[];
    };
    expect(filter.$and).toEqual(
      expect.arrayContaining([
        { _id: couponOrderId },
        { tenant: tenantId },
        { stripeSessionId: "cs_legacy_voucher" },
        emptyVoucherConnectedAccountClause,
        {
          $or: [
            { stripeLivemode: { $exists: false } },
            { stripeLivemode: null },
            { stripeLivemode: false },
          ],
        },
      ]),
    );
  });
});
