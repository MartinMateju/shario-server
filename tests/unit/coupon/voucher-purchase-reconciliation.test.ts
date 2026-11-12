import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  finalize: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/config/logger.js", () => ({ logger: { error: mocks.error } }));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  CouponOrder: { find: mocks.find },
}));
vi.mock("@/modules/coupon/coupon.service.js", () => ({
  couponService: { finalizePaidCouponOrder: mocks.finalize },
}));

import { COUPON_STATUS } from "@/modules/coupon/coupon.constants.js";
import { reconcilePaidVoucherPurchases } from "@/modules/coupon/voucher-purchase-reconciliation.service.js";

const now = new Date("2026-09-15T12:00:00Z");
let query: {
  select: ReturnType<typeof vi.fn>;
  sort: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  lean: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  query = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  };
  for (const method of [query.select, query.sort, query.limit, query.lean])
    method.mockReturnValue(query);
  mocks.find.mockReturnValue(query);
});

describe("confirmed voucher purchase recovery", () => {
  it("selects only confirmed, unfinished, unrefunded purchases whose issuance lease is available", async () => {
    await expect(reconcilePaidVoucherPurchases()).resolves.toEqual({
      examined: 0,
      completed: 0,
      failed: 0,
    });

    expect(mocks.find).toHaveBeenCalledWith({
      status: COUPON_STATUS.PENDING_PAYMENT,
      paidAt: { $ne: null },
      processedAt: null,
      refundState: { $in: [null, "none"] },
      refundedAmountMinor: { $in: [null, 0] },
      $or: [
        { isProcessing: false },
        { processingLeaseExpiresAt: null },
        { processingLeaseExpiresAt: { $lte: now } },
      ],
    });
    expect(query.limit).toHaveBeenCalledWith(25);
    expect(query.sort).toHaveBeenCalledWith({ updatedAt: 1, _id: 1 });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("continues after one issuance failure and forwards each purchase's saved payment evidence", async () => {
    const orders = Array.from({ length: 3 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(),
      tenant: new mongoose.Types.ObjectId(),
      stripeSessionId: `cs_paid_${index}`,
      stripePaymentIntentId: `pi_paid_${index}`,
      paidAt: new Date(`2026-09-${12 + index}T10:00:00Z`),
    }));
    query.exec.mockResolvedValue(orders);
    mocks.finalize
      .mockRejectedValueOnce(new Error("Outbox unavailable"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(reconcilePaidVoucherPurchases()).resolves.toEqual({
      examined: 3,
      completed: 1,
      failed: 1,
    });

    expect(mocks.finalize).toHaveBeenCalledTimes(3);
    orders.forEach((order, index) => {
      expect(mocks.finalize).toHaveBeenNthCalledWith(index + 1, {
        tenantId: String(order.tenant),
        couponOrderId: String(order._id),
        sessionId: order.stripeSessionId,
        paymentIntentId: order.stripePaymentIntentId,
        paidAt: order.paidAt,
      });
    });
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it.each([
    [1_000, 100],
    [-10, 1],
    [2.9, 2],
    [Number.NaN, 25],
  ])("bounds requested batch size %s to %s", async (limit, boundedLimit) => {
    await reconcilePaidVoucherPurchases({ limit });
    expect(query.limit).toHaveBeenCalledWith(boundedLimit);
  });
});
