import { describe, expect, it } from "vitest";

import {
  hasPaidBookingSource,
  resolveBookingRefundSnapshot,
} from "../../../src/modules/booking/services/booking.refund.service.js";
import {
  couponAmountToMinorUnits,
  normalizeCouponCurrency,
} from "../../../src/modules/coupon/coupon.utils.js";
import {
  normalizeCreditCurrency,
  toMinorUnits,
} from "../../../src/modules/money-credit/money-credit.utils.js";

describe("commerce currency integrity", () => {
  it("never treats an unpaid booking hold as a refundable purchase", () => {
    expect(
      hasPaidBookingSource({
        paymentStatus: "PENDING_PAYMENT",
        orders: [{ isPaid: false }],
      }),
    ).toBe(false);
    expect(
      hasPaidBookingSource({
        paymentStatus: "CONFIRMED",
        orders: [],
      }),
    ).toBe(true);
    expect(
      hasPaidBookingSource({
        paymentStatus: "PENDING_PAYMENT",
        orders: [{ isPaid: true }],
      }),
    ).toBe(true);
  });

  it("uses ISO minor units for two-decimal and zero-decimal currencies", () => {
    expect(toMinorUnits(12.34, "EUR")).toBe(1234);
    expect(toMinorUnits(1234, "JPY")).toBe(1234);
    expect(couponAmountToMinorUnits(987, "CLP")).toBe(987);
  });

  it("normalizes supported currencies and rejects unsupported values", () => {
    expect(normalizeCreditCurrency(" eur ")).toBe("EUR");
    expect(normalizeCouponCurrency("jpy")).toBe("JPY");
    expect(() => normalizeCreditCurrency("KRW")).toThrow(
      "Unsupported studio commerce currency",
    );
  });

  it("prefers an immutable paid cart snapshot for a booking refund", () => {
    const snapshot = resolveBookingRefundSnapshot(
      {
        _id: "booking-1",
        createdBy: "user-1",
        status: "processed",
        start: new Date("2030-01-01T10:00:00.000Z"),
        tag: "workshop",
        bookingProduct: {
          _id: "product-1",
          price: 9999,
          currency: "USD",
        },
        numberOfHours: 4,
        numberOfGuests: 5,
        orders: [
          {
            _id: "order-1",
            isPaid: true,
            currency: "EUR",
            cart: {
              currency: "EUR",
              cartItems: [
                {
                  product: "product-1",
                  totalPrice: 24.5,
                },
              ],
            },
          },
        ],
      },
      "CZK",
    );

    expect(snapshot).toEqual({
      currency: "EUR",
      refundAmount: 24.5,
      source: "cart_snapshot",
      relatedOrder: "order-1",
    });
  });

  it("refunds the discounted immutable order line instead of the catalog cart total", () => {
    const snapshot = resolveBookingRefundSnapshot(
      {
        _id: "booking-1",
        createdBy: "user-1",
        status: "processed",
        paymentStatus: "CONFIRMED",
        start: new Date("2030-01-01T10:00:00.000Z"),
        tag: "workshop",
        bookingProduct: {
          _id: "product-1",
          price: 100,
          currency: "EUR",
        },
        orders: [
          {
            _id: "order-1",
            isPaid: true,
            currency: "EUR",
            workshopBookings: ["booking-1"],
            lineItems: [
              {
                product: "product-1",
                grossAmountMinor: 7_500,
              },
            ],
            cart: {
              currency: "EUR",
              cartItems: [
                {
                  product: "product-1",
                  totalPrice: 100,
                },
              ],
            },
          },
        ],
      },
      "EUR",
    );

    expect(snapshot).toEqual({
      currency: "EUR",
      refundAmount: 75,
      source: "order_line_snapshot",
      relatedOrder: "order-1",
    });
  });

  it("preserves valid legacy fallback precision for the currency", () => {
    const snapshot = resolveBookingRefundSnapshot(
      {
        _id: "booking-1",
        createdBy: "user-1",
        status: "processed",
        start: new Date("2030-01-01T10:00:00.000Z"),
        tag: "workshop",
        bookingProduct: {
          _id: "product-1",
          price: 12.34,
          currency: "EUR",
        },
        numberOfHours: 1,
        numberOfGuests: 1,
      },
      "CZK",
    );

    expect(snapshot.currency).toBe("EUR");
    expect(snapshot.refundAmount).toBe(12.34);
    expect(snapshot.source).toBe("legacy_product_price");
  });

  it("rejects fractional snapshots for zero-decimal currencies", () => {
    expect(() =>
      resolveBookingRefundSnapshot(
        {
          _id: "booking-1",
          createdBy: "user-1",
          status: "processed",
          start: new Date("2030-01-01T10:00:00.000Z"),
          tag: "workshop",
          bookingProduct: {
            _id: "product-1",
            price: 100,
            currency: "JPY",
          },
          orders: [
            {
              _id: "order-1",
              isPaid: true,
              currency: "JPY",
              cart: {
                currency: "JPY",
                cartItems: [
                  {
                    product: "product-1",
                    totalPrice: 100.5,
                  },
                ],
              },
            },
          ],
        },
        "CZK",
      ),
    ).toThrow("invalid precision for JPY");
  });

  it("rejects conflicting order and cart currency snapshots", () => {
    expect(() =>
      resolveBookingRefundSnapshot(
        {
          _id: "booking-1",
          createdBy: "user-1",
          status: "processed",
          start: new Date("2030-01-01T10:00:00.000Z"),
          tag: "workshop",
          bookingProduct: {
            _id: "product-1",
            price: 100,
            currency: "EUR",
          },
          orders: [
            {
              _id: "order-1",
              isPaid: true,
              currency: "EUR",
              cart: {
                currency: "USD",
                cartItems: [
                  {
                    product: "product-1",
                    totalPrice: 100,
                  },
                ],
              },
            },
          ],
        },
        "CZK",
      ),
    ).toThrow("conflicting currency snapshots");
  });
});
