import { describe, expect, it } from "vitest";

import {
  buildServerPricedCartItems,
  calculateCreditsDiscount,
  assertStripePayableAmountAfterCredits,
  resolveServerCheckoutCurrency,
} from "@/modules/checkout/services/checkout.pricing.service.js";

describe("checkout currency integrity", () => {
  it("derives currency from server products and tenant settings", () => {
    expect(
      resolveServerCheckoutCurrency({
        products: [{ currency: "EUR" }, { currency: "EUR" }],
        tenantCurrency: "EUR",
        requestedCurrency: "eur",
      }),
    ).toBe("eur");
  });

  it("rejects mixed currencies and client currency mismatches", () => {
    expect(() =>
      resolveServerCheckoutCurrency({
        products: [{ currency: "EUR" }, { currency: "USD" }],
        tenantCurrency: "EUR",
      }),
    ).toThrow(/same currency/);

    expect(() =>
      resolveServerCheckoutCurrency({
        products: [{ currency: "EUR" }],
        tenantCurrency: "EUR",
        requestedCurrency: "USD",
      }),
    ).toThrow(/must match/);
  });

  it("stores cart snapshots using per-unit amounts", () => {
    const product = {
      _id: "product-1",
      type: "private-workshop",
      price: 100,
      extraCharge: 25,
    };
    const items = buildServerPricedCartItems({
      cartItems: [
        {
          product: { _id: product._id },
          quantity: 2,
          numberOfPeople: 1,
          bookingType: "private",
        },
      ],
      productById: new Map([[product._id, product]]),
    });

    expect(items[0]).toMatchObject({
      basePrice: 100,
      extraCharge: 25,
    });
    expect(items[0].totalPrice).toBe(
      (items[0].basePrice + items[0].extraCharge) * items[0].quantity,
    );
  });

  it("rejects malformed minor-unit totals instead of rounding them", () => {
    expect(() =>
      calculateCreditsDiscount({
        requestedCreditsMajor: 1,
        totalMinor: 100.5,
        currency: "EUR",
      }),
    ).toThrow(/minor-unit integer/);

    expect(() =>
      calculateCreditsDiscount({
        requestedCreditsMajor: 1,
        totalMinor: -1,
        currency: "EUR",
      }),
    ).toThrow(/minor-unit integer/);
  });

  it("rejects zero and sub-minimum Stripe totals after credits", () => {
    expect(() =>
      assertStripePayableAmountAfterCredits({
        expectedAmountMinor: 0,
        appliedCreditsMinor: 1_000,
        minimumAmountMinor: 50,
        currency: "EUR",
      }),
    ).toThrow(/credits checkout/i);

    expect(() =>
      assertStripePayableAmountAfterCredits({
        expectedAmountMinor: 49,
        appliedCreditsMinor: 951,
        minimumAmountMinor: 50,
        currency: "EUR",
      }),
    ).toThrow(/minimum charge/i);

    expect(() =>
      assertStripePayableAmountAfterCredits({
        expectedAmountMinor: 50,
        appliedCreditsMinor: 950,
        minimumAmountMinor: 50,
        currency: "EUR",
      }),
    ).not.toThrow();
  });
});
