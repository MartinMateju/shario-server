import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addOwnedVoucherPaymentContext,
  buildVoucherCheckoutPlan,
  getVoucherCheckoutPlan,
  normalizeCheckoutVoucherCode,
} from "@/modules/checkout/services/checkout.voucher.service.js";
import {
  assertExpectedVoucherQuote,
  requireExpectedVoucherQuote,
} from "@/modules/checkout/checkout.voucher.validation.js";
import Order from "@/modules/order/order.model.js";
import { VoucherLifecycleError } from "@/modules/coupon/voucher-lifecycle.service.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";
import { assertValidCartProducts } from "@/modules/checkout/services/checkout.cart.service.js";

const id = (suffix: string) =>
  new mongoose.Types.ObjectId(`64b0000000000000000000${suffix}`);
const product = id("01");
const otherProduct = id("02");
const coupon = (overrides: any = {}) => ({
  _id: id("03"),
  lifecycleVersion: 1,
  isActive: true,
  currencySnapshot: "CZK",
  voucherTypeSnapshot: "value",
  remainingValueMinor: 5000,
  reservedValueMinor: 0,
  remainingQuantity: 0,
  reservedQuantity: 0,
  voucherSettingsSnapshot: { eligibleProductIds: [] },
  ...overrides,
});
const line = (overrides: any = {}) => ({
  product,
  quantity: 2,
  grossAmountMinor: 10000,
  ...overrides,
});
const plan = (overrides: any = {}) =>
  buildVoucherCheckoutPlan({
    coupon: coupon(),
    lineItems: [line()],
    currency: "CZK",
    orderId: String(id("04")),
    ...overrides,
  });

describe("server-priced direct voucher allocation", () => {
  it.each([true, false])(
    "only exposes a pending order owned by the caller: %s",
    async (owned) => {
      const cq = {
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({ _id: id("03") }),
      };
      const oq = {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(owned ? { _id: id("04") } : null),
      };
      vi.spyOn(Coupon, "findOne").mockReturnValue(cq as any);
      const lookup = vi.spyOn(Order, "findOne").mockReturnValue(oq as any);
      const error = new VoucherLifecycleError(
        "VOUCHER_PAYMENT_PENDING",
        "Pending payment",
      );
      await expect(
        addOwnedVoucherPaymentContext(error, {
          tenantId: String(id("05")),
          userId: String(id("06")),
          voucherCode: "GIFT-ABCD",
        }),
      ).rejects.toMatchObject(
        owned
          ? { details: { orderId: String(id("04")) } }
          : { details: undefined },
      );
      expect(lookup).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: String(id("05")),
          createdBy: String(id("06")),
          "voucherRedemptions.couponId": id("03"),
        }),
      );
    },
  );

  afterEach(() => vi.restoreAllMocks());
  it("funds the remainder as card tender without changing invoice lines", () => {
    const lines = [line()];
    const result = plan({ lineItems: lines });
    expect(result).toMatchObject({
      totalAmountMinor: 10000,
      voucherAppliedMinor: 5000,
      remainingToPayMinor: 5000,
      remainingVoucherValueMinor: 0,
      cardRequired: true,
    });
    expect(lines).toEqual([line()]);
    expect(result.allocations[0]).toMatchObject({
      lineIndex: 0,
      amountMinor: 5000,
      appliedAmountMinor: 5000,
      quantity: 0,
      eligibleProductId: product,
    });
  });
  it("leaves unused voucher value for another booking", () => {
    expect(
      plan({ coupon: coupon({ remainingValueMinor: 15000 }) }),
    ).toMatchObject({
      remainingToPayMinor: 0,
      remainingVoucherValueMinor: 5000,
      cardRequired: false,
    });
  });
  it("honors restricted products and records each refundable line separately", () => {
    const result = plan({
      coupon: coupon({
        remainingValueMinor: 30000,
        voucherSettingsSnapshot: { eligibleProductIds: [product] },
      }),
      lineItems: [
        line({ product: otherProduct }),
        line(),
        line({ grossAmountMinor: 2000 }),
      ],
    });
    expect(result.voucherAppliedMinor).toBe(12000);
    expect(result.allocations.map((row) => row.lineIndex)).toEqual([1, 2]);
    expect(
      new Set(result.allocations.map((row) => row.reservationId)).size,
    ).toBe(2);
    expect(result.remainingToPayMinor).toBe(10000);
  });
  it("keeps an issued product-restricted value voucher valid for the original studio product after location assignment", () => {
    const location = id("07");
    const studioProduct = { _id: product, type: "workshop", kind: "open-studio", location };
    const issued = coupon({ voucherSettingsSnapshot: { eligibleProductIds: [product] } });
    expect(assertValidCartProducts({
      cartItems: [{ product: { _id: product, type: "workshop" }, locationId: String(location) }],
      productById: new Map([[String(product), studioProduct]]),
    })).toBe(true);
    expect(plan({ coupon: issued, lineItems: [line({ location })] }))
      .toMatchObject({ voucherAppliedMinor: 5000 });
    expect(issued.voucherSettingsSnapshot.eligibleProductIds).toEqual([product]);
    // A separately created product at another location does not silently gain
    // eligibility under the voucher's purchased restrictions.
    expect(() => plan({ coupon: issued, lineItems: [line({ product: otherProduct })] }))
      .toThrowError(expect.objectContaining({ code: "VOUCHER_INELIGIBLE" }));
  });
  it("subtracts concurrent held value from the spendable balance", () => {
    expect(
      plan({ coupon: coupon({ reservedValueMinor: 2500 }) })
        .voucherAppliedMinor,
    ).toBe(2500);
  });
  it("spends experience entitlement by participant quantity instead of monetary value", () => {
    const result = plan({
      coupon: coupon({
        voucherTypeSnapshot: "experience",
        remainingQuantity: 3,
        reservedQuantity: 1,
        remainingValueMinor: 0,
        voucherSettingsSnapshot: { experienceProductId: product },
      }),
      lineItems: [line({ quantity: 3, grossAmountMinor: 15000 })],
    });
    expect(result).toMatchObject({
      voucherAppliedMinor: 10000,
      remainingToPayMinor: 5000,
      remainingVoucherQuantity: 0,
    });
    expect(result.allocations[0]).toMatchObject({
      amountMinor: 0,
      quantity: 2,
      appliedAmountMinor: 10000,
    });
  });
  it.each([
    ["VOUCHER_LEGACY_REDEMPTION_REQUIRED", { lifecycleVersion: 0 }],
    ["VOUCHER_UNAVAILABLE", { isActive: false }],
    ["VOUCHER_UNAVAILABLE", { redeemedAt: new Date() }],
    ["VOUCHER_UNAVAILABLE", { revokedAt: new Date() }],
    ["VOUCHER_EXPIRED", { expiresAt: new Date(0) }],
    ["VOUCHER_CURRENCY_MISMATCH", { currencySnapshot: "EUR" }],
    ["VOUCHER_RECONCILIATION_REQUIRED", { refundReviewRequired: true }],
    ["VOUCHER_PAYMENT_PENDING", { reservedValueMinor: 5000 }],
    ["VOUCHER_BALANCE_INCONSISTENT", { remainingValueMinor: 0.5 }],
    [
      "VOUCHER_INELIGIBLE",
      { voucherSettingsSnapshot: { eligibleProductIds: [otherProduct] } },
    ],
  ])("rejects %s before reserving", (code, changes) => {
    expect(() => plan({ coupon: coupon(changes) })).toThrowError(
      expect.objectContaining({ code }),
    );
  });
  it("tenant-filters voucher lookup and uses normalized code", async () => {
    const exec = vi.fn().mockResolvedValue(coupon());
    const query = {
      session: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec,
    };
    const find = vi.spyOn(Coupon, "findOne").mockReturnValue(query as any);
    await getVoucherCheckoutPlan({
      tenantId: String(id("05")),
      voucherCode: " gift-abcd ",
      lineItems: [line()],
      currency: "CZK",
    });
    expect(find).toHaveBeenCalledWith({
      tenant: id("05"),
      promoCode: "GIFT-ABCD",
    });
  });
  it("rejects object/control-character codes before database access", () => {
    for (const value of [
      { promoCode: "CODE" },
      "<script>",
      "ABC\nDEF",
      "a".repeat(121),
    ])
      expect(() => normalizeCheckoutVoucherCode(value)).toThrowError(
        expect.objectContaining({ code: "VOUCHER_CODE_INVALID" }),
      );
  });
  it("dispatches fully funded checkout into the atomic booking transaction without Stripe", async () => {
    vi.spyOn(checkoutRepository, "findCardCheckoutRecovery").mockResolvedValue(
      null,
    );
    vi.spyOn(checkoutService, "quoteVoucherCheckout").mockResolvedValue({
      remainingToPayMinor: 0,
    } as any);
    const complete = vi
      .spyOn(checkoutService, "checkoutWithCredits")
      .mockResolvedValue({ status: "confirmed", voucherFunded: true } as any);
    const old = process.env.STRIPE_KEY;
    delete process.env.STRIPE_KEY;
    try {
      await expect(
        checkoutService.createStripeCheckout({
          tenantId: String(id("05")),
          user: { _id: id("06") },
          cartItems: [],
          originUrl: "https://studio.shario.io",
          currency: "CZK",
          voucherCode: "GIFT-ABCD",
          checkoutOperation: {
            orderId: id("04"),
            cartId: id("07"),
            operationId: "operation-id",
          },
        }),
      ).resolves.toMatchObject({ status: "confirmed" });
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentSource: "voucher",
          voucherCode: "GIFT-ABCD",
        }),
      );
    } finally {
      if (old !== undefined) process.env.STRIPE_KEY = old;
    }
  });
  it("requires an accepted quote at the HTTP boundary", () => {
    expect(() => requireExpectedVoucherQuote(undefined)).toThrowError(
      expect.objectContaining({ code: "VOUCHER_QUOTE_REQUIRED" }),
    );
  });
  it.each([
    "currency",
    "totalAmountMinor",
    "voucherAppliedMinor",
    "remainingToPayMinor",
  ])("rejects a changed %s before funding", (key) => {
    const accepted = {
      currency: "CZK" as const,
      totalAmountMinor: 10000,
      voucherAppliedMinor: 5000,
      remainingToPayMinor: 5000,
    };
    const changed = { ...accepted, [key]: key === "currency" ? "EUR" : 6000 };
    expect(() =>
      assertExpectedVoucherQuote(accepted, changed as any),
    ).toThrowError(expect.objectContaining({ code: "VOUCHER_QUOTE_CHANGED" }));
  });
  it("keeps full-credit payment exclusive from direct voucher checkout", async () => {
    await expect(
      checkoutService.createStripeCheckout({
        tenantId: String(id("05")),
        user: { _id: id("06") },
        cartItems: [],
        originUrl: "https://studio.shario.io",
        currency: "CZK",
        voucherCode: "GIFT-ABCD",
        creditsToApplyMajor: 10,
      }),
    ).rejects.toMatchObject({
      code: "PARTIAL_CREDIT_CARD_PAYMENT_UNSUPPORTED",
    });
  });
});
