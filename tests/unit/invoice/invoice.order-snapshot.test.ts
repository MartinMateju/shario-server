import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  assertReferencedBookingContexts,
  attachWorkshopBookingsToOrderLines,
  buildOrderInvoicePaymentAllocations,
  buildOrderLineSnapshots,
  hasTrustedOrderInvoiceSnapshot,
} from "@/modules/invoice/order-invoice-snapshot.service.js";

const PRODUCT_ID = new mongoose.Types.ObjectId();
const BOOKING_ID = new mongoose.Types.ObjectId();
const LOCATION_ID = new mongoose.Types.ObjectId();
const COURSE_BOOKING_ID = new mongoose.Types.ObjectId();
const WORKSHOP_BOOKING_ID = new mongoose.Types.ObjectId();

const productMap = new Map([
  [
    String(PRODUCT_ID),
    { _id: PRODUCT_ID, name: { CZ: "Česká keramická lekce" }, sku: "LESSON" },
  ],
]);

describe("order invoice snapshots", () => {
  it("links each newly created workshop to its exact immutable order line", () => {
    const firstBooking = new mongoose.Types.ObjectId();
    const secondBooking = new mongoose.Types.ObjectId();
    const lines = attachWorkshopBookingsToOrderLines({
      sourceCartItems: [
        {
          product: { type: "workshop" },
          start: "2026-08-01T08:00:00.000Z",
          end: "2026-08-01T10:00:00.000Z",
        },
        { product: { type: "course" }, bookingCourse: COURSE_BOOKING_ID },
        {
          product: { type: "service" },
          start: "2026-08-02T08:00:00.000Z",
          end: "2026-08-02T09:00:00.000Z",
        },
      ],
      lineItems: [
        { description: "Open studio", booking: null },
        { description: "Course", booking: COURSE_BOOKING_ID },
        { description: "Wheel rental", booking: null },
      ],
      bookingIds: [firstBooking, secondBooking],
    });

    expect(lines.map((line) => String(line.booking))).toEqual([
      String(firstBooking),
      String(COURSE_BOOKING_ID),
      String(secondBooking),
    ]);
  });

  it("creates exact EUR minor-unit and location snapshots", () => {
    const lines = buildOrderLineSnapshots({
      sourceCartItems: [{ product: PRODUCT_ID, bookingId: BOOKING_ID }],
      pricedCartItems: [
        { product: PRODUCT_ID, quantity: 2, basePrice: 10, extraCharge: 0.25 },
      ],
      productById: productMap,
      currency: "EUR",
      defaultTaxRateBps: 2_100,
      pricesIncludeTax: true,
      relatedLocationByBookingId: new Map([
        [String(BOOKING_ID), LOCATION_ID],
      ]),
    });

    expect(lines[0]).toMatchObject({
      description: "Česká keramická lekce",
      quantity: 2,
      unitGrossMinor: 1_025,
      grossAmountMinor: 2_050,
      taxRateBps: 2_100,
    });
    expect(lines[0].netAmountMinor + lines[0].taxAmountMinor).toBe(2_050);
    expect(lines[0].locationIds.map(String)).toEqual([String(LOCATION_ID)]);
  });

  it("uses zero-decimal minor units for JPY", () => {
    const [line] = buildOrderLineSnapshots({
      sourceCartItems: [{ product: PRODUCT_ID }],
      pricedCartItems: [
        { product: PRODUCT_ID, quantity: 1, basePrice: 500, extraCharge: 0 },
      ],
      productById: productMap,
      currency: "JPY",
      defaultTaxRateBps: 0,
      pricesIncludeTax: false,
    });
    expect(line.unitGrossMinor).toBe(500);
    expect(line.grossAmountMinor).toBe(500);
  });

  it("rejects nonzero tax-exclusive checkout pricing", () => {
    expect(() =>
      buildOrderLineSnapshots({
        sourceCartItems: [{ product: PRODUCT_ID }],
        pricedCartItems: [
          { product: PRODUCT_ID, quantity: 1, basePrice: 10, extraCharge: 0 },
        ],
        productById: productMap,
        currency: "EUR",
        defaultTaxRateBps: 2_100,
        pricesIncludeTax: false,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EXCLUSIVE_TAX_NOT_SUPPORTED" }),
    );
  });

  it("rejects fractional and out-of-range checkout tax settings", () => {
    for (const defaultTaxRateBps of [2_100.5, -1, 10_001]) {
      expect(() =>
        buildOrderLineSnapshots({
          sourceCartItems: [{ product: PRODUCT_ID }],
          pricedCartItems: [
            { product: PRODUCT_ID, quantity: 1, basePrice: 10, extraCharge: 0 },
          ],
          productById: productMap,
          currency: "EUR",
          defaultTaxRateBps,
          pricesIncludeTax: true,
        }),
      ).toThrow(/integer between 0 and 10000 basis points/);
    }
  });

  it("only trusts legacy lines with exact tax-inclusive snapshots", () => {
    const trusted = {
      grossAmountMinor: 1_000,
      isPaid: false,
      lineItems: [
        {
          quantity: 1,
          unitGrossMinor: 1_000,
          grossAmountMinor: 1_000,
          netAmountMinor: 826,
          taxAmountMinor: 174,
          taxRateBps: 2_100,
        },
      ],
    };

    expect(hasTrustedOrderInvoiceSnapshot(trusted)).toBe(true);
    expect(
      hasTrustedOrderInvoiceSnapshot({
        ...trusted,
        lineItems: [
          { ...trusted.lineItems[0], netAmountMinor: 825, taxAmountMinor: 175 },
        ],
      }),
    ).toBe(false);
    expect(
      hasTrustedOrderInvoiceSnapshot({
        ...trusted,
        lineItems: [{ ...trusted.lineItems[0], taxRateBps: 2_100.5 }],
      }),
    ).toBe(false);
    expect(
      hasTrustedOrderInvoiceSnapshot({
        ...trusted,
        lineItems: [{ ...trusted.lineItems[0], taxRateBps: 10_001 }],
      }),
    ).toBe(false);
  });

  it.each([
    ["class", "open-studio"],
    ["class", "workshop"],
    ["course", "open-studio"],
    ["course", "workshop"],
  ])("maps %s and %s booking references to their invoice locations", (courseTag, workshopTag) => {
    const locations = assertReferencedBookingContexts({
      courseBookingIds: [COURSE_BOOKING_ID],
      guestIncreaseBookingIds: [WORKSHOP_BOOKING_ID],
      contexts: [
        {
          _id: COURSE_BOOKING_ID,
          tag: courseTag,
          location: LOCATION_ID,
        },
        {
          _id: WORKSHOP_BOOKING_ID,
          tag: workshopTag,
          location: LOCATION_ID,
        },
      ],
    });

    expect(String(locations.get(String(COURSE_BOOKING_ID)))).toBe(
      String(LOCATION_ID),
    );
    expect(String(locations.get(String(WORKSHOP_BOOKING_ID)))).toBe(
      String(LOCATION_ID),
    );
  });

  it.each([
    ["course", "open-studio"],
    ["course", "workshop"],
    ["course", "private-studio"],
    ["course", "guest-increase"],
    ["guest-increase", "class"],
    ["guest-increase", "course"],
    ["guest-increase", "private-studio"],
    ["guest-increase", "guest-increase"],
  ])("rejects a %s reference to a %s booking", (referenceType, tag) => {
    expect(() => assertReferencedBookingContexts({
      courseBookingIds: referenceType === "course" ? [BOOKING_ID] : [],
      guestIncreaseBookingIds: referenceType === "guest-increase" ? [BOOKING_ID] : [],
      contexts: [{ _id: BOOKING_ID, tag, location: LOCATION_ID }],
    })).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_BOOKING_REFERENCE_INVALID" }),
    );
  });

  it.each(["class", "open-studio"])("requires a valid location for a %s reference", (tag) => {
    expect(() => assertReferencedBookingContexts({
      courseBookingIds: tag === "class" ? [BOOKING_ID] : [],
      guestIncreaseBookingIds: tag === "open-studio" ? [BOOKING_ID] : [],
      contexts: [{ _id: BOOKING_ID, tag, location: "not-a-location-id" }],
    })).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_BOOKING_REFERENCE_INVALID" }),
    );
  });

  it("rejects missing, mistyped, and conflicting booking references", () => {
    expect(() =>
      assertReferencedBookingContexts({
        courseBookingIds: [COURSE_BOOKING_ID],
        guestIncreaseBookingIds: [],
        contexts: [],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_BOOKING_REFERENCE_INVALID" }),
    );

    expect(() =>
      assertReferencedBookingContexts({
        courseBookingIds: [COURSE_BOOKING_ID],
        guestIncreaseBookingIds: [],
        contexts: [
          {
            _id: COURSE_BOOKING_ID,
            tag: "workshop",
            location: LOCATION_ID,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_BOOKING_REFERENCE_INVALID" }),
    );

    expect(() =>
      assertReferencedBookingContexts({
        courseBookingIds: [COURSE_BOOKING_ID],
        guestIncreaseBookingIds: [COURSE_BOOKING_ID],
        contexts: [],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_BOOKING_REFERENCE_CONFLICT" }),
    );
  });

  it("builds deterministic trusted-order invoice payment allocations", () => {
    const paidAt = new Date("2026-07-21T10:00:00.000Z");
    const allocations = buildOrderInvoicePaymentAllocations({
      orderId: "order-1",
      paidAt,
      allocations: [
        {
          method: "stripe",
          amountMinor: 1_000,
          providerReference: "cs_test_1",
        },
        {
          method: "credits",
          amountMinor: 500,
          providerReference: "",
        },
      ],
    });

    expect(allocations).toEqual([
      expect.objectContaining({
        method: "stripe",
        amountMinor: 1_000,
        idempotencyKey: "order:order-1:stripe:cs_test_1",
        paidAt,
        recordedAt: paidAt,
      }),
      expect.objectContaining({
        method: "credits",
        amountMinor: 500,
        idempotencyKey: "order:order-1:credits:1",
        paidAt,
        recordedAt: paidAt,
      }),
    ]);
  });
});
