import { describe, expect, it, vi } from "vitest";
vi.mock("@/modules/product/product.model.js", () => ({ default: {} }));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import {
  couponRepository,
  withCouponHistoricalDisplay,
} from "@/modules/coupon/coupon.repository.js";

describe("voucher historical display", () => {
  it("keeps the purchased name and value after an offering is edited", () => {
    const result = withCouponHistoricalDisplay({
      product: {
        name: "New workshop",
        price: 2000,
        currency: "EUR",
        imageSrc: "cover",
      },
      productNameSnapshot: "Original workshop",
      valueMinorSnapshot: 12345,
      currencySnapshot: "CZK",
      order: { productNameSnapshot: "Order name", unitPriceSnapshot: 999 },
    });
    expect(result.product).toEqual({
      name: "Original workshop",
      price: 123.45,
      currency: "CZK",
      imageSrc: "cover",
    });
  });
  it("keeps order-backed legacy history after an offering is deleted", () => {
    expect(
      withCouponHistoricalDisplay({
        product: null,
        order: {
          productNameSnapshot: "Deleted workshop",
          unitPriceSnapshot: 500,
          currencySnapshot: "CZK",
        },
      }).product,
    ).toEqual({ name: "Deleted workshop", price: 500, currency: "CZK" });
  });
  it("respects zero-decimal currencies when displaying immutable minor units", () => {
    expect(
      withCouponHistoricalDisplay({
        valueMinorSnapshot: 12345,
        currencySnapshot: "JPY",
      }).product.price,
    ).toBe(12345);
  });
});

describe("voucher delivery completion", () => {
  it("completes using an atomic update without saving a stale issuance document", async () => {
    const startedAt = new Date();
    const order: any = {
      _id: "order",
      tenant: "tenant",
      stripeSessionId: "cs_test",
      processingStartedAt: startedAt,
      emailSent: false,
      customerEmailSent: true,
      adminEmailSent: false,
      adminEmailSkipped: true,
      save: vi.fn(),
    };
    const update = vi
      .spyOn(CouponOrder, "findOneAndUpdate")
      .mockReturnValue({
        exec: async () => ({ ...order, processedAt: new Date() }),
      } as never);
    await couponRepository.markCouponOrderProcessed(order, [], [], "event");
    const [filter, change] = update.mock.calls[0] as any;
    expect(filter).toMatchObject({
      _id: "order",
      tenant: "tenant",
      stripeSessionId: "cs_test",
      isProcessing: true,
      processingStartedAt: startedAt,
      refundState: { $in: [null, "none"] },
      refundedAmountMinor: { $in: [null, 0] },
    });
    expect(change.$set.emailSent).toBe(true);
    expect(change.$set.adminEmailSent).toBeUndefined();
    expect(change.$set.adminEmailSentAt).toBeUndefined();
    expect(change.$set.customerEmailSentAt).toBeInstanceOf(Date);
    expect(change.$addToSet).toEqual({ processedStripeEventIds: "event" });
    expect(order.save).not.toHaveBeenCalled();
  });

  it("leaves a concurrently refunded order untouched", async () => {
    vi.spyOn(CouponOrder, "findOneAndUpdate").mockReturnValue({
      exec: async () => null,
    } as never);
    const refunded: any = {
      _id: "order",
      tenant: "tenant",
      refundState: "revoked",
      refundedAmountMinor: 1000,
    };
    vi.spyOn(CouponOrder, "findOne").mockReturnValue({
      exec: async () => refunded,
    } as never);
    await expect(
      couponRepository.markCouponOrderProcessed(refunded, [], [], "event"),
    ).resolves.toBe(refunded);
  });
});
