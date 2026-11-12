import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  assertValidCartProducts,
  assertValidCartLocations,
  buildOpenStudioBookingsToCreate,
  buildCourseBookings,
  buildGuestIncreaseBookings,
  extractLocationIdsOrThrow,
  hasStandaloneServiceItems,
} from "@/modules/checkout/services/checkout.cart.service.js";
import { getBookingExtraChargeMajor } from "@/modules/checkout/services/checkout.pricing.service.js";

describe("checkout booking-reference preflight", () => {
  it.each(["workshop", "public-workshop", "private-workshop"])(
    "requires the persisted %s product location and ignores client location claims",
    (type) => {
      const productId = new mongoose.Types.ObjectId();
      const location = new mongoose.Types.ObjectId();
      const anotherLocation = new mongoose.Types.ObjectId();
      const product = { _id: productId, type, location };
      const item = {
        product: { _id: productId, type, location: anotherLocation },
        locationId: String(location),
      };
      const validate = (dbProduct = product, cartItem = item) =>
        assertValidCartProducts({
          cartItems: [cartItem],
          productById: new Map([[String(productId), dbProduct]]),
        });

      expect(() => validate()).not.toThrow();
      expect(() => validate(product, { ...item, locationId: String(anotherLocation) }))
        .toThrowError(expect.objectContaining({ code: "PRODUCT_LOCATION_MISMATCH" }));
      expect(() => validate({ ...product, location: undefined as never }))
        .toThrowError(expect.objectContaining({ code: "PRODUCT_LOCATION_REQUIRED" }));
    },
  );

  it("rejects a product outside the tenant-scoped result even when its client location matches", () => {
    expect(() => assertValidCartProducts({
      cartItems: [{ product: { _id: new mongoose.Types.ObjectId(), type: "workshop" }, locationId: new mongoose.Types.ObjectId() }],
      productById: new Map(),
    })).toThrowError(expect.objectContaining({
      code: "BAD_REQUEST", details: { reason: "PRODUCT_NOT_FOUND" },
    }));
  });

  it.each(["guest-increase", "prolong"])("keeps %s add-ons usable for existing reservations without a new studio assignment", (type) => {
    const productId = new mongoose.Types.ObjectId();
    expect(assertValidCartProducts({
      cartItems: [{ product: { _id: productId, type } }],
      productById: new Map([[String(productId), { _id: productId, type }]]),
    })).toBe(true);
  });

  it("ignores a client attempt to make a private Open Studio product public", () => {
    const productId = new mongoose.Types.ObjectId();
    const locationId = new mongoose.Types.ObjectId();
    const product = {
      _id: productId,
      type: "workshop",
      kind: "open-studio",
      bookingMode: "private",
      extraCharge: 75,
      maxNumberOfParticipants: 4,
    };
    const cartItem = {
      product: {
        _id: productId,
        type: "workshop",
        kind: "open-studio",
        bookingMode: "public",
      },
      locationId,
      start: new Date("2026-08-03T08:00:00.000Z"),
      end: new Date("2026-08-03T09:00:00.000Z"),
      numberOfGuests: 1,
      bookingMode: "public",
      bookingType: "public",
    };
    const productById = new Map([[String(productId), product]]);

    const [snapshot] = buildOpenStudioBookingsToCreate({
      cartItems: [cartItem],
      productById,
      user: {
        _id: new mongoose.Types.ObjectId(),
        firstname: "Ada",
        customId: "CUSTOMER-1",
      },
      paymentMode: "credits",
    });

    expect(snapshot).toMatchObject({
      bookingMode: "private",
      bookingType: "private",
      numberOfGuests: 1,
      tag: "open-studio",
    });
    expect(getBookingExtraChargeMajor(cartItem, product)).toBe(75);
  });

  it("uses the DB default for a legacy workshop and enforces DB product capacity", () => {
    const productId = new mongoose.Types.ObjectId();
    const locationId = new mongoose.Types.ObjectId();
    const product = {
      _id: productId,
      type: "workshop",
      maxNumberOfParticipants: 2,
    };
    const baseItem = {
      product: { _id: productId, type: "workshop" },
      locationId,
      start: new Date("2026-08-03T08:00:00.000Z"),
      end: new Date("2026-08-03T09:00:00.000Z"),
      bookingMode: "private",
      bookingType: "private",
    };
    const productById = new Map([[String(productId), product]]);
    const user = {
      _id: new mongoose.Types.ObjectId(),
      firstname: "Ada",
      customId: "CUSTOMER-1",
    };

    expect(
      buildOpenStudioBookingsToCreate({
        cartItems: [{ ...baseItem, numberOfGuests: 2 }],
        productById,
        user,
        paymentMode: "credits",
      })[0],
    ).toMatchObject({
      bookingMode: "public",
      bookingType: "public",
      numberOfGuests: 2,
    });

    expect(() =>
      buildOpenStudioBookingsToCreate({
        cartItems: [{ ...baseItem, numberOfGuests: 3 }],
        productById,
        user,
        paymentMode: "credits",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "BOOKING_PRODUCT_CAPACITY_EXCEEDED",
        details: expect.objectContaining({ maximum: 2, requested: 3 }),
      }),
    );
  });

  it("rejects Private Studio from checkout using server product data", () => {
    const productId = new mongoose.Types.ObjectId();
    const cartItems = [
      {
        product: {
          _id: productId,
          type: "blocker",
        },
        quantity: 1,
      },
    ];

    expect(() =>
      assertValidCartProducts({
        cartItems,
        productById: new Map([
          [
            String(productId),
            {
              _id: productId,
              kind: "private-studio",
              type: "blocker",
            },
          ],
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PRIVATE_STUDIO_NOT_SELLABLE" }),
    );
  });

  it("accepts a standalone service as billable work without a booking", () => {
    const productId = new mongoose.Types.ObjectId();
    const cartItems = [
      {
        product: {
          _id: productId,
          type: "service",
        },
        quantity: 3,
      },
    ];

    expect(
      assertValidCartProducts({
        cartItems,
        productById: new Map([
          [
            String(productId),
            {
              _id: productId,
              type: "service",
            },
          ],
        ]),
      }),
    ).toBe(true);
    expect(hasStandaloneServiceItems(cartItems)).toBe(true);
  });

  it("requires standalone services to belong to an active location", () => {
    const locationId = new mongoose.Types.ObjectId();
    const service = {
      product: { type: "service" },
      quantity: 3,
      locationId,
    };

    expect(extractLocationIdsOrThrow([service]).map(String)).toEqual([
      String(locationId),
    ]);
    expect(
      assertValidCartLocations({
        cartItems: [service],
        locationById: new Map([
          [
            String(locationId),
            { _id: locationId, booking: { enabled: false } },
          ],
        ]),
      }),
    ).toBe(true);

    expect(() =>
      extractLocationIdsOrThrow([
        {
          product: { type: "service" },
          quantity: 1,
        },
      ]),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "INVALID_LOCATION_ID" }),
      }),
    );
  });

  it("does not allow a workshop at a location where booking is disabled", () => {
    const locationId = new mongoose.Types.ObjectId();

    expect(() =>
      assertValidCartLocations({
        cartItems: [
          {
            product: { type: "public-workshop" },
            locationId,
          },
        ],
        locationById: new Map([
          [
            String(locationId),
            { _id: locationId, booking: { enabled: false } },
          ],
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "LOCATION_BOOKING_DISABLED",
        }),
      }),
    );
  });

  it("rejects malformed course references instead of silently dropping them", () => {
    expect(() =>
      buildCourseBookings([
        {
          product: { type: "public-course" },
          bookingCourse: "not-an-object-id",
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_BOOKING_REFERENCE_INVALID" }),
    );
  });

  it("rejects malformed guest-increase references and quantities", () => {
    expect(() =>
      buildGuestIncreaseBookings([
        {
          product: { type: "guest-increase" },
          bookingId: "not-an-object-id",
          addGuests: 1,
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_BOOKING_REFERENCE_INVALID" }),
    );

    expect(() =>
      buildGuestIncreaseBookings([
        {
          product: { type: "guest-increase" },
          bookingId: new mongoose.Types.ObjectId(),
          addGuests: 0,
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_GUEST_INCREASE_INVALID" }),
    );
  });
});
