import { describe, expect, it } from "vitest";

import {
  applyOrderLinePricesToStripePayload,
  buildServerPricedCartItems,
  buildStripeLineItems,
} from "@/modules/checkout/services/checkout.pricing.service.js";
import { buildOrderLineSnapshots } from "@/modules/invoice/order-invoice-snapshot.service.js";

const productId = "507f1f77bcf86cd799439011";
const product = {
  _id: productId,
  name: "Studio reservation",
  type: "workshop",
  kind: "open-studio",
  bookingMode: "customer-choice",
  price: 125,
  // A legacy surcharge must not leak into the new pricing policy.
  extraCharge: 999,
  currency: "CZK",
  openStudioPolicy: {
    publicCapacityMode: "fixed",
    publicCapacityLimit: 2,
    privateBookingSurcharge: 75,
  },
};

const cartItem = (bookingMode = "private", numberOfGuests = 1) => ({
  product: { _id: productId, type: "workshop", price: 1 },
  start: "2030-10-10T10:00:00.000Z",
  end: "2030-10-10T12:00:00.000Z",
  bookingMode,
  bookingType: bookingMode,
  numberOfGuests,
  // None of these untrusted pricing fields can change the server total.
  quantity: 1,
  extraCharge: -75,
  privateBookingSurcharge: 0,
  totalPrice: 1,
});

describe("customer-choice booking pricing", () => {
  it.each([1, 2, 8])("charges the flat private fee once for %i people", (people) => {
    const [priced] = buildServerPricedCartItems({
      cartItems: [cartItem("private", people)],
      productById: new Map([[productId, product]]),
    });

    expect(priced).toMatchObject({
      quantity: 1,
      basePrice: 125 * 4 * people,
      extraCharge: 75,
      totalPrice: 125 * 4 * people + 75,
      numberOfPeople: people,
    });
  });

  it("charges public parties normal rates without either private surcharge", () => {
    const [priced] = buildServerPricedCartItems({
      cartItems: [cartItem("public", 2)],
      productById: new Map([[productId, product]]),
    });
    expect(priced).toMatchObject({
      quantity: 8,
      basePrice: 125,
      extraCharge: 0,
      totalPrice: 1000,
    });
  });

  it("keeps private Stripe, order and invoice totals identical with indivisible fees", () => {
    const preciseProduct = {
      ...product,
      price: 12.34,
      currency: "EUR",
      openStudioPolicy: { ...product.openStudioPolicy, privateBookingSurcharge: 10.01 },
    };
    const productById = new Map([[productId, preciseProduct]]);
    const sourceCartItems = [{ ...cartItem("private", 3), end: "2030-10-10T11:30:00.000Z" }];
    const pricedCartItems = buildServerPricedCartItems({ cartItems: sourceCartItems, productById });
    const lines = buildOrderLineSnapshots({
      sourceCartItems,
      pricedCartItems,
      productById,
      currency: "EUR",
      defaultTaxRateBps: 2100,
      pricesIncludeTax: true,
    });
    const stripe = buildStripeLineItems({ cartItems: sourceCartItems, productById, currency: "EUR" });
    const finalStripe = applyOrderLinePricesToStripePayload({ stripePayload: stripe, orderLineItems: lines });

    expect(pricedCartItems[0].totalPrice).toBeCloseTo(121.07);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 1, unitGrossMinor: 12107, grossAmountMinor: 12107 });
    expect(lines[0].netAmountMinor + lines[0].taxAmountMinor).toBe(12107);
    expect(stripe.lineItems[0].quantity).toBe(1);
    expect(stripe.totalMinor).toBe(12107);
    expect(finalStripe.totalMinor).toBe(12107);
  });

  it("charges the flat fee once for each separate private reservation", () => {
    const items = buildServerPricedCartItems({
      cartItems: [cartItem(), { ...cartItem(), start: "2030-10-11T10:00:00.000Z", end: "2030-10-11T12:00:00.000Z" }],
      productById: new Map([[productId, product]]),
    });
    expect(items.map((item) => item.extraCharge)).toEqual([75, 75]);
    expect(items.reduce((sum, item) => sum + item.totalPrice, 0)).toBe(1150);
  });

  it("supports a free base rate with a paid private surcharge", () => {
    const stripe = buildStripeLineItems({
      cartItems: [cartItem()],
      productById: new Map([[productId, { ...product, price: 0 }]]),
      currency: "CZK",
    });
    expect(stripe.totalMinor).toBe(7500);
    expect(stripe.lineItems[0].quantity).toBe(1);
  });

  it("leaves the legacy fixed private pricing unchanged", () => {
    const legacy = { ...product, bookingMode: "private", extraCharge: 25 };
    const productById = new Map([[productId, legacy]]);
    const solo = buildServerPricedCartItems({ cartItems: [cartItem()], productById });
    const group = buildServerPricedCartItems({ cartItems: [cartItem("private", 2)], productById });
    expect(solo[0]).toMatchObject({ quantity: 4, basePrice: 125, extraCharge: 25, totalPrice: 600 });
    expect(group[0]).toMatchObject({ quantity: 8, basePrice: 125, extraCharge: 0, totalPrice: 1000 });
  });
});
