import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCoupon: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/modules/product/product.model.js", () => ({ default: {} }));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: {
    create: mocks.createCoupon,
    collection: { updateMany: mocks.updateMany },
  },
  CouponOrder: {},
}));

import { couponRepository } from "@/modules/coupon/coupon.repository.js";

describe("native coupon snapshot persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCoupon.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
    });
    mocks.updateMany.mockResolvedValue({ modifiedCount: 1 });
  });

  it("requires and persists an immutable snapshot when issuing a coupon", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();

    await couponRepository.createCoupon({
      tenantId: String(tenantId),
      productId,
      couponOrderId: orderId,
      promoCode: "NATIVE-CODE-001",
      valueMinorSnapshot: 12_345,
      currencySnapshot: "EUR",
    });

    expect(mocks.createCoupon).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: tenantId,
        product: productId,
        order: orderId,
        promoCode: "NATIVE-CODE-001",
        valueMinorSnapshot: 12_345,
        currencySnapshot: "EUR",
      }),
    );
  });

  it("upgrades only legacy order coupons with neither snapshot half", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();

    await couponRepository.setMissingCouponValueSnapshotsForOrder({
      tenantId: String(tenantId),
      couponOrderId: orderId,
      valueMinorSnapshot: 50_000,
      currencySnapshot: "CZK",
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      {
        tenant: tenantId,
        order: orderId,
        valueMinorSnapshot: null,
        currencySnapshot: null,
      },
      {
        $set: {
          valueMinorSnapshot: 50_000,
          currencySnapshot: "CZK",
        },
      },
    );
  });
});
