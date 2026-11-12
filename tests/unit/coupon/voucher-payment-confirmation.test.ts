import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";

const tenantId = "64b000000000000000000001";
const couponOrderId = "64b000000000000000000012";
const payment = {
  tenantId,
  couponOrderId,
  sessionId: "cs_verified_voucher",
  paymentIntentId: "pi_verified_voucher",
  paidAt: new Date("2026-09-15T12:00:00Z"),
};

describe("durable voucher payment confirmation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes a supported pipeline through Mongoose and scopes the write to the exact purchase", async () => {
    // Mock the MongoDB boundary, not Model.updateOne. Mongoose must still
    // accept/cast the repository's update before this driver call is reached.
    const write = vi
      .spyOn(CouponOrder.collection, "updateOne")
      .mockResolvedValue({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      });

    await expect(
      couponRepository.recordConfirmedCouponPayment(payment),
    ).resolves.toBeUndefined();

    expect(write).toHaveBeenCalledOnce();
    const [filter, update] = write.mock.calls[0];
    expect(filter).toMatchObject({
      _id: new mongoose.Types.ObjectId(couponOrderId),
      tenant: new mongoose.Types.ObjectId(tenantId),
      stripeSessionId: payment.sessionId,
      stripePaymentIntentId: { $in: [null, "", payment.paymentIntentId] },
    });
    expect(update).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          $set: expect.objectContaining({
            paidAt: { $ifNull: ["$paidAt", { $literal: payment.paidAt }] },
            stripePaymentIntentId: { $literal: payment.paymentIntentId },
          }),
        }),
      ]),
    );
  });

  it("requires a matching persisted payment and refuses an invalid confirmation date", async () => {
    const write = vi
      .spyOn(CouponOrder.collection, "updateOne")
      .mockResolvedValue({
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      });

    await expect(
      couponRepository.recordConfirmedCouponPayment(payment),
    ).rejects.toThrow("snapshot changed");
    await expect(
      couponRepository.recordConfirmedCouponPayment({
        ...payment,
        paidAt: new Date(NaN),
      }),
    ).rejects.toThrow("Invalid confirmed payment date");

    expect(write).toHaveBeenCalledOnce();
  });
});
