import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  buildCourseBookings,
} from "@/modules/checkout/services/checkout.cart.service.js";
import {
  isActiveCapacityBooking,
  validateCourseAvailabilityOrThrow,
  validateGuestIncreaseAvailabilityOrThrow,
} from "@/modules/checkout/services/checkout.capacity.service.js";
import {
  buildServerPricedCartItems,
} from "@/modules/checkout/services/checkout.pricing.service.js";
import { getStripeCheckoutExpiryWindow } from "@/modules/checkout/checkout.utils.js";

const makeCourseItem = ({
  productId = new mongoose.Types.ObjectId(),
  slotId = new mongoose.Types.ObjectId(),
  type = "course",
  quantity = 2,
  numberOfGuests,
  guests = [{}],
}: {
  productId?: mongoose.Types.ObjectId;
  slotId?: mongoose.Types.ObjectId;
  type?: string;
  quantity?: unknown;
  numberOfGuests?: unknown;
  guests?: unknown;
} = {}) => ({
  product: { _id: productId, type },
  bookingCourse: slotId,
  quantity,
  ...(numberOfGuests === undefined ? {} : { numberOfGuests }),
  ...(guests === undefined ? {} : { guests }),
});

describe("guest-increase checkout integrity", () => {
  const makeContext = ({
    ownerId = new mongoose.Types.ObjectId(),
    currentGuests = 3,
    addGuests = 1,
    billingBlocks = 2,
    capacity = 8,
  } = {}) => {
    const bookingId = new mongoose.Types.ObjectId();
    const locationId = new mongoose.Types.ObjectId();
    const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    return {
      ownerId,
      bookingId,
      operation: {
        bookingId,
        addGuests,
        billingBlocks,
      },
      target: {
        _id: bookingId,
        createdBy: ownerId,
        location: locationId,
        start,
        end,
        status: "processed",
        paymentStatus: "CONFIRMED",
        numberOfGuests: currentGuests,
        bookingType: "private",
        plannedActivity: "UNDEFINED",
        tag: "workshop",
      },
      locationById: new Map([
        [
          String(locationId),
          {
            _id: locationId,
            isActive: true,
            booking: {
              enabled: true,
              globalCapacity: capacity,
              privateSessionBlocksAll: false,
              groupBookingBlocksAll: false,
              allowPublicSoloOverlap: true,
              maxPublicSoloOverlaps: capacity,
              activityCapacities: [],
            },
          },
        ],
      ]),
    };
  };

  it("rejects attempts to add guests to another customer's booking", () => {
    const context = makeContext();

    expect(() =>
      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: [context.operation],
        targets: [context.target],
        userId: new mongoose.Types.ObjectId(),
        currentBookings: [context.target],
        locationById: context.locationById,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_GUEST_INCREASE_NOT_OWNED" }),
    );
  });

  it("rejects client billing blocks that understate the booking duration", () => {
    const context = makeContext({ billingBlocks: 1 });

    expect(() =>
      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: [context.operation],
        targets: [context.target],
        userId: context.ownerId,
        currentBookings: [context.target],
        locationById: context.locationById,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_GUEST_INCREASE_DURATION_MISMATCH",
      }),
    );
  });

  it("rejects guest increases beyond the location's remaining capacity", () => {
    const context = makeContext({
      currentGuests: 4,
      addGuests: 2,
      capacity: 5,
    });

    expect(() =>
      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: [context.operation],
        targets: [context.target],
        userId: context.ownerId,
        currentBookings: [context.target],
        locationById: context.locationById,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }),
    );
  });
});

describe("course checkout integrity", () => {
  it("keeps reservation deadlines safely beyond the fixed Session deadline", () => {
    const now = Date.parse("2026-07-22T10:00:00.000Z");
    const expiry = getStripeCheckoutExpiryWindow(now);

    expect(expiry.sessionExpiresAt.getTime()).toBe(
      expiry.sessionExpiresAtSeconds * 1000,
    );
    expect(expiry.workshopReservationExpiresAt.getTime()).toBeGreaterThan(
      expiry.sessionExpiresAt.getTime(),
    );
    expect(expiry.courseReservationExpiresAt.getTime()).toBeGreaterThanOrEqual(
      expiry.sessionExpiresAt.getTime() + 24 * 60 * 60 * 1000,
    );
  });

  it("counts unexpired pending workshop bookings as capacity reservations", () => {
    const now = new Date("2026-07-22T10:00:00.000Z");
    const base = {
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      tag: "workshop",
    };

    expect(
      isActiveCapacityBooking(
        {
          ...base,
          paymentExpiresAt: new Date("2026-07-22T10:01:00.000Z"),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isActiveCapacityBooking(
        {
          ...base,
          paymentExpiresAt: new Date("2026-07-22T09:59:00.000Z"),
        },
        now,
      ),
    ).toBe(false);
  });

  it("rejects quantity and guest-list mismatches", () => {
    expect(() =>
      buildCourseBookings([
        makeCourseItem({
          quantity: 1,
          guests: [{}, {}, {}],
        }),
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_COURSE_PARTICIPANT_MISMATCH",
      }),
    );

    expect(() =>
      buildCourseBookings([
        makeCourseItem({
          quantity: 2,
          numberOfGuests: 3,
          guests: [{}],
        }),
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_COURSE_PARTICIPANT_MISMATCH",
      }),
    );
  });

  it.each(["course", "public-course", "private-course"])(
    "uses one normalized participant quantity for %s pricing and fulfillment",
    (type) => {
      const productId = new mongoose.Types.ObjectId();
      const slotId = new mongoose.Types.ObjectId();
      const cartItem = makeCourseItem({
        productId,
        slotId,
        type,
        quantity: 3,
        numberOfGuests: 3,
        guests: [{}, {}],
      });
      const product = {
        _id: productId,
        type,
        price: 25,
        extraCharge: 0,
      };

      const bookings = buildCourseBookings([cartItem]);
      const priced = buildServerPricedCartItems({
        cartItems: [cartItem],
        productById: new Map([[String(productId), product]]),
      });

      expect(bookings).toEqual([
        expect.objectContaining({
          bookingId: slotId,
          productId,
          quantity: 3,
        }),
      ]);
      expect(priced[0]).toMatchObject({
        product: productId,
        quantity: 3,
        numberOfPeople: 3,
        totalPrice: 75,
      });
    },
  );

  it("rejects a course slot linked to a different priced product", () => {
    const requestedProductId = new mongoose.Types.ObjectId();
    const actualProductId = new mongoose.Types.ObjectId();
    const slotId = new mongoose.Types.ObjectId();

    expect(() =>
      validateCourseAvailabilityOrThrow({
        courseBookings: [
          {
            bookingId: slotId,
            productId: requestedProductId,
            quantity: 1,
          },
        ],
        slots: [
          {
            _id: slotId,
            bookingProduct: actualProductId,
            numberOfGuests: 0,
          },
        ],
        productById: new Map([
          [
            String(requestedProductId),
            {
              _id: requestedProductId,
              type: "course",
              maxNumberOfParticipants: 8,
            },
          ],
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_COURSE_PRODUCT_MISMATCH",
      }),
    );
  });

  it("rejects a request that exceeds the server-side remaining capacity", () => {
    const productId = new mongoose.Types.ObjectId();
    const slotId = new mongoose.Types.ObjectId();

    expect(() =>
      validateCourseAvailabilityOrThrow({
        courseBookings: [
          {
            bookingId: slotId,
            productId,
            quantity: 3,
          },
        ],
        slots: [
          {
            _id: slotId,
            bookingProduct: productId,
            numberOfGuests: 6,
          },
        ],
        productById: new Map([
          [
            String(productId),
            {
              _id: productId,
              type: "course",
              maxNumberOfParticipants: 8,
            },
          ],
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "CHECKOUT_COURSE_CAPACITY_EXCEEDED",
        details: expect.objectContaining({
          available: 2,
          requested: 3,
        }),
      }),
    );
  });

  it("fails closed when a course product has no configured capacity", () => {
    const productId = new mongoose.Types.ObjectId();
    const slotId = new mongoose.Types.ObjectId();

    expect(() =>
      validateCourseAvailabilityOrThrow({
        courseBookings: [
          {
            bookingId: slotId,
            productId,
            quantity: 1,
          },
        ],
        slots: [
          {
            _id: slotId,
            bookingProduct: productId,
            numberOfGuests: 0,
          },
        ],
        productById: new Map([
          [String(productId), { _id: productId, type: "course" }],
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_COURSE_CAPACITY_NOT_CONFIGURED",
      }),
    );
  });

  it("rejects a Stripe-paid course that starts before Session expiry", () => {
    const productId = new mongoose.Types.ObjectId();
    const slotId = new mongoose.Types.ObjectId();

    expect(() =>
      validateCourseAvailabilityOrThrow({
        courseBookings: [
          {
            bookingId: slotId,
            productId,
            quantity: 1,
          },
        ],
        slots: [
          {
            _id: slotId,
            bookingProduct: productId,
            numberOfGuests: 0,
            start: new Date("2026-07-22T10:20:00.000Z"),
          },
        ],
        productById: new Map([
          [
            String(productId),
            {
              _id: productId,
              type: "course",
              maxNumberOfParticipants: 8,
            },
          ],
        ]),
        mustStartAfter: new Date("2026-07-22T10:30:00.000Z"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_COURSE_START_TOO_SOON" }),
    );
  });

  it("rejects a slot missing from the tenant-scoped query result", () => {
    const productId = new mongoose.Types.ObjectId();
    const slotId = new mongoose.Types.ObjectId();

    expect(() =>
      validateCourseAvailabilityOrThrow({
        courseBookings: [
          {
            bookingId: slotId,
            productId,
            quantity: 1,
          },
        ],
        slots: [],
        productById: new Map([
          [String(productId), { _id: productId, type: "course" }],
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_COURSE_SLOT_INVALID" }),
    );
  });
});
