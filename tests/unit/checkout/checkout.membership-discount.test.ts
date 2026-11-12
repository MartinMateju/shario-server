import { describe, expect, it } from "vitest";

import {
  applyMembershipDiscountToOrderLines,
  buildMembershipDiscountSnapshot,
  calculatePercentageDiscountMinor,
  chooseBestCheckoutDiscount,
} from "@/modules/checkout/services/checkout.discount.service.js";
import { Order } from "@/modules/order/order.model.js";
import { applyOrderLinePricesToStripePayload } from "@/modules/checkout/services/checkout.pricing.service.js";
import { attachWorkshopBookingsToOrderLines, buildOrderLineSnapshots, collectOrderLocationIds } from "@/modules/invoice/order-invoice-snapshot.service.js";

const membershipDiscount = {
  membershipId: "507f1f77bcf86cd799439011",
  planId: "507f1f77bcf86cd799439012",
  planVersionId: "507f1f77bcf86cd799439013",
  planVersion: 4,
  benefitKey: "member_products",
  benefitLabel: "Member product discount",
  percentageBps: 1_500,
  selectedLocationId: null,
};

const line = (overrides = {}) => ({
  product: "507f1f77bcf86cd799439020",
  description: "Open studio",
  sku: "OPEN",
  quantity: 2,
  unitGrossMinor: 10_001,
  grossAmountMinor: 20_002,
  netAmountMinor: 16_531,
  taxAmountMinor: 3_471,
  taxRateBps: 2_100,
  locationIds: ["507f1f77bcf86cd799439030"],
  ...overrides,
});

describe("checkout membership discounts", () => {
  const personalDiscount = { ...membershipDiscount, memberOnly: true, productScope: "courses" as const };
  it.each(["selected", "shared_selected"])("ignores a forged covered location for an out-of-scope course (%s)", (scope) => {
    const productId = "507f1f77bcf86cd799439020";
    const bookingId = "507f1f77bcf86cd799439021";
    const coveredLocation = "507f1f77bcf86cd799439030";
    const actualLocation = "507f1f77bcf86cd799439031";
    const snapshotAt = (location: string) => buildOrderLineSnapshots({
      sourceCartItems: [{ product: { _id: productId }, bookingCourse: bookingId, locationId: coveredLocation }],
      pricedCartItems: [{ product: productId, quantity: 2, basePrice: 100, extraCharge: 0 }],
      productById: new Map([[productId, { _id: productId, type: "public-course", kind: "class", name: "Course" }]]),
      currency: "CZK", defaultTaxRateBps: 0, pricesIncludeTax: true,
      relatedLocationByBookingId: new Map([[bookingId, location]]),
    });
    const discount = { ...personalDiscount, ...(scope === "selected" ? { selectedLocationId: coveredLocation } : { allowedLocationIds: [coveredLocation] }) };
    const lines = snapshotAt(actualLocation);
    expect(lines[0].locationIds.map(String)).toEqual([actualLocation]);
    expect(collectOrderLocationIds(lines).map(String)).toEqual([actualLocation]);
    expect(applyMembershipDiscountToOrderLines({ lineItems: lines, discount, eligibleCourseBookingIds: new Set([bookingId]) }).amountMinor).toBe(0);
    expect(applyMembershipDiscountToOrderLines({ lineItems: snapshotAt(coveredLocation), discount, eligibleCourseBookingIds: new Set([bookingId]) }).amountMinor).toBe(1500);
  });
  it("discounts one member seat per course, including duplicate lines, and leaves companions at full price", () => {
    const result = applyMembershipDiscountToOrderLines({ lineItems: [line({ booking: "event-a", quantity: 3 }), line({ booking: "event-a", quantity: 2 })], discount: personalDiscount, eligibleCourseBookingIds: new Set(["event-a"]) });
    expect(result.amountMinor).toBe(1500);
    expect(result.personalCourseBookingIds).toEqual(["event-a"]);
    expect(result.lineItems.map(({ quantity, unitGrossMinor }) => [quantity, unitGrossMinor])).toEqual([[1, 8501], [2, 10001], [2, 10001]]);
    for (const item of result.lineItems) expect(item.unitGrossMinor * item.quantity).toBe(item.grossAmountMinor);
  });
  it("does not discount prior member reservations, vouchers, unselected courses or another studio", () => {
    const result = applyMembershipDiscountToOrderLines({
      discount: { ...personalDiscount, allowedLocationIds: ["studio-a"], eligibleProductIds: ["course-a"] },
      eligibleCourseBookingIds: new Set(["already-paid", "not-selected", "wrong-location"]), unavailableCourseBookingIds: new Set(["already-paid"]),
      lineItems: [line({ product: "course-a", booking: "already-paid", locationIds: ["studio-a"] }), line({ product: "voucher", locationIds: ["studio-a"] }), line({ product: "course-b", booking: "not-selected", locationIds: ["studio-a"] }), line({ product: "course-a", booking: "wrong-location", locationIds: ["studio-b"] })],
    });
    expect(result.amountMinor).toBe(0);
    expect(result.personalCourseBookingIds).toEqual([]);
  });
  it("keeps split course seats aligned with Stripe and a later studio booking", () => {
    const result = applyMembershipDiscountToOrderLines({ lineItems: [line({ booking: "event-a", quantity: 3 }), line({ quantity: 1 })], discount: personalDiscount, eligibleCourseBookingIds: new Set(["event-a"]) });
    const stripe = applyOrderLinePricesToStripePayload({ stripePayload: { currency: "czk", lineItems: [{ quantity: 3, price_data: { currency: "czk", unit_amount: 10001, product_data: { name: "Course" } } }, { quantity: 1, price_data: { currency: "czk", unit_amount: 10001, product_data: { name: "Studio" } } }] }, orderLineItems: result.lineItems });
    expect(stripe.totalMinor).toBe(result.totalAmountMinor);
    expect(stripe.lineItems.map((item) => [item.price_data.product_data.name, item.quantity])).toEqual([["Course", 1], ["Course", 2], ["Studio", 1]]);
    const linked = attachWorkshopBookingsToOrderLines({ sourceCartItems: [{ product: { type: "public-course" } }, { product: { type: "public-workshop" } }], lineItems: result.lineItems, bookingIds: ["507f1f77bcf86cd799439088"] });
    expect(String(linked[2].booking)).toBe("507f1f77bcf86cd799439088");
    expect(linked[0].booking).toBe("event-a");
    expect(linked[1].booking).toBe("event-a");
  });
  it("calculates percentages using deterministic integer minor-unit math", () => {
    expect(
      calculatePercentageDiscountMinor({
        amountMinor: 10_001,
        percentageBps: 1_500,
      }),
    ).toBe(1_500);

    // The same calculation is valid for zero-decimal currencies such as JPY.
    expect(
      calculatePercentageDiscountMinor({
        amountMinor: 999,
        percentageBps: 1_250,
      }),
    ).toBe(124);
  });

  it("reprices each unit and keeps invoice arithmetic trustworthy", () => {
    const result = applyMembershipDiscountToOrderLines({
      lineItems: [line()],
      discount: membershipDiscount,
    });

    expect(result).toMatchObject({
      subtotalAmountMinor: 20_002,
      amountMinor: 3_000,
      totalAmountMinor: 17_002,
    });
    expect(result.lineItems[0].unitGrossMinor).toBe(8_501);
    expect(result.lineItems[0].grossAmountMinor).toBe(17_002);
    expect(
      result.lineItems[0].netAmountMinor +
        result.lineItems[0].taxAmountMinor,
    ).toBe(17_002);
  });

  it("discounts only matching lines for a location-scoped membership", () => {
    const locationId = "507f1f77bcf86cd799439030";
    const result = applyMembershipDiscountToOrderLines({
      lineItems: [
        line({ quantity: 1, grossAmountMinor: 10_001 }),
        line({
          quantity: 1,
          grossAmountMinor: 10_001,
          locationIds: ["507f1f77bcf86cd799439099"],
        }),
      ],
      discount: { ...membershipDiscount, selectedLocationId: locationId },
    });

    expect(result.amountMinor).toBe(1_500);
    expect(result.lineItems.map((item) => item.unitGrossMinor)).toEqual([
      8_501,
      10_001,
    ]);
  });

  it("uses only the larger discount and leaves a coupon unused on ties", () => {
    const membership = {
      source: "membership" as const,
      amountMinor: 2_000,
      label: "Member discount",
      membership: membershipDiscount,
    };
    const largerCoupon = {
      source: "coupon" as const,
      amountMinor: 2_500,
      label: "WELCOME",
      coupon: { couponId: null, promoCode: "WELCOME" },
    };

    expect(
      chooseBestCheckoutDiscount({
        subtotalAmountMinor: 10_000,
        membership,
        coupon: largerCoupon,
      })?.source,
    ).toBe("coupon");

    expect(
      chooseBestCheckoutDiscount({
        subtotalAmountMinor: 10_000,
        membership,
        coupon: { ...largerCoupon, amountMinor: 2_000 },
      })?.source,
    ).toBe("membership");
  });

  it("builds an immutable identity snapshot for the order", () => {
    expect(
      buildMembershipDiscountSnapshot({
        discount: membershipDiscount,
        subtotalAmountMinor: 20_002,
        amountMinor: 3_000,
        currency: "CZK",
        appliedAt: new Date("2026-07-23T12:00:00.000Z"),
      }),
    ).toMatchObject({
      source: "membership",
      currency: "CZK",
      subtotalAmountMinor: 20_002,
      amountMinor: 3_000,
      percentageBps: 1_500,
      membership: {
        membershipId: membershipDiscount.membershipId,
        planVersion: 4,
        benefitKey: "member_products",
      },
    });
  });

  it("rejects an order that tries to stack a coupon with a membership discount", async () => {
    const order = new Order({
      tenant: "507f1f77bcf86cd799439001",
      cart: "507f1f77bcf86cd799439002",
      createdBy: "507f1f77bcf86cd799439003",
      status: "pending_order",
      currency: "CZK",
      grossAmountMinor: 8_000,
      expectedAmountMinor: 8_000,
      appliedDiscount: {
        source: "membership",
        label: "Member discount",
        currency: "CZK",
        subtotalAmountMinor: 10_000,
        amountMinor: 2_000,
        percentageBps: 2_000,
        membership: {
          membershipId: membershipDiscount.membershipId,
          planId: membershipDiscount.planId,
          planVersionId: membershipDiscount.planVersionId,
          planVersion: 4,
          benefitKey: membershipDiscount.benefitKey,
          benefitLabel: membershipDiscount.benefitLabel,
        },
        appliedAt: new Date(),
      },
      appliedCoupons: [
        {
          promoCode: "WELCOME",
          value: 20,
          currency: "CZK",
        },
      ],
    });

    await expect(order.validate()).rejects.toThrow(
      "Coupon and membership discounts cannot be combined",
    );
  });
});
