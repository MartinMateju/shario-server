import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setMissingCouponValueSnapshotsForOrder: vi.fn(),
  listCouponsForOrder: vi.fn(),
  createCoupon: vi.fn(),
}));

vi.mock("@/modules/coupon/coupon.repository.js", () => ({
  couponRepository: {
    setMissingCouponValueSnapshotsForOrder:
      mocks.setMissingCouponValueSnapshotsForOrder,
    listCouponsForOrder: mocks.listCouponsForOrder,
    createCoupon: mocks.createCoupon,
  },
}));

import {
  couponService,
  getPendingCouponDeliveryChannels,
} from "@/modules/coupon/coupon.service.js";

describe("voucher fulfillment idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses order-scoped vouchers after a transient fulfillment retry", async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    const productId = new mongoose.Types.ObjectId();
    const couponOrderId = new mongoose.Types.ObjectId();
    const persisted: Array<{
      _id: mongoose.Types.ObjectId;
      promoCode: string;
      valueMinorSnapshot: number;
      currencySnapshot: "CZK";
    }> = [];

    mocks.setMissingCouponValueSnapshotsForOrder.mockResolvedValue({
      modifiedCount: 0,
    });
    mocks.listCouponsForOrder.mockImplementation(async () => [...persisted]);
    mocks.createCoupon.mockImplementation(async () => {
      const index = persisted.length + 1;
      const coupon = {
        _id: new mongoose.Types.ObjectId(),
        promoCode: `ABC-DEF-00${index}`,
        valueMinorSnapshot: 10_000,
        currencySnapshot: "CZK" as const,
      };
      persisted.push(coupon);
      return coupon;
    });

    const input = {
      tenantId,
      productId,
      quantity: 2,
      couponOrderId,
      valueMinorSnapshot: 10_000,
      currencySnapshot: "CZK" as const,
      createdBy: null,
    };
    const first = await couponService.createCouponsForOrder(input);

    // Historical partially completed issuance can already have durable codes.
    // Recovery fills only missing entitlements and never replaces existing codes.
    const retry = await couponService.createCouponsForOrder(input);

    expect(mocks.setMissingCouponValueSnapshotsForOrder).toHaveBeenCalledTimes(
      2,
    );
    expect(
      mocks.setMissingCouponValueSnapshotsForOrder,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId,
        couponOrderId,
        valueMinorSnapshot: 10_000,
        currencySnapshot: "CZK",
      }),
    );
    expect(mocks.createCoupon).toHaveBeenCalledTimes(2);
    expect(retry.coupons.map(String)).toEqual(first.coupons.map(String));
    expect(retry.promoCodes).toEqual(first.promoCodes);
    expect(new Set(retry.promoCodes).size).toBe(2);
  });

  it("retries only the voucher email channel that was not durably recorded", () => {
    expect(
      getPendingCouponDeliveryChannels({
        adminEmailSent: true,
        customerEmailSent: false,
      }),
    ).toEqual({ admin: false, customer: true });

    expect(
      getPendingCouponDeliveryChannels({
        emailSent: true,
        adminEmailSent: false,
        customerEmailSent: false,
      }),
    ).toEqual({ admin: false, customer: false });
  });
});
