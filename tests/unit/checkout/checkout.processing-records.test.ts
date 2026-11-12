import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { Order } from "@/modules/order/order.model.js";
import { createOrderRepository } from "@/modules/order/order.repository.js";

const queryResult = <T>(value: T) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const findResult = <T>(value: T) => ({
  select: vi.fn().mockReturnValue({
    lean: vi.fn().mockReturnValue(queryResult(value)),
  }),
});

describe("Stripe Checkout processing-record lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves two replaced-tab Stripe orders, carts, and linked bookings", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const olderOrderId = new mongoose.Types.ObjectId();
    const newerOrderId = new mongoose.Types.ObjectId();
    const attachingOrderId = new mongoose.Types.ObjectId();
    const replaceableOrderId = new mongoose.Types.ObjectId();
    const replaceableCartId = new mongoose.Types.ObjectId();

    vi.spyOn(Order, "find").mockReturnValue(
      findResult([
        {
          _id: olderOrderId,
          cart: new mongoose.Types.ObjectId(),
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          stripe: { sessionId: "cs_older" },
        },
        {
          _id: newerOrderId,
          cart: new mongoose.Types.ObjectId(),
          createdAt: new Date(),
          stripe: { sessionId: "cs_newer" },
        },
        {
          _id: attachingOrderId,
          cart: new mongoose.Types.ObjectId(),
          createdAt: new Date(),
          stripe: { sessionId: "" },
        },
        {
          _id: replaceableOrderId,
          cart: replaceableCartId,
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          stripe: { sessionId: "" },
        },
      ]) as never,
    );
    const bookingDelete = vi
      .spyOn(Booking, "deleteMany")
      .mockReturnValue(queryResult({ deletedCount: 1 }) as never);
    vi.spyOn(Booking, "updateMany").mockReturnValue(
      queryResult({ modifiedCount: 1 }) as never,
    );
    const cartDelete = vi
      .spyOn(Cart, "deleteMany")
      .mockReturnValue(queryResult({ deletedCount: 1 }) as never);
    const orderDelete = vi
      .spyOn(Order, "deleteMany")
      .mockReturnValue(queryResult({ deletedCount: 1 }) as never);

    await checkoutRepository.deleteProcessingRecords({ tenantId, userId });

    expect(bookingDelete).toHaveBeenCalledWith({
      tenant: tenantId,
      status: "pending",
      createdBy: userId,
      orders: { $in: [replaceableOrderId] },
    });
    expect(cartDelete).toHaveBeenCalledWith({
      tenant: tenantId,
      _id: { $in: [replaceableCartId] },
    });
    expect(orderDelete).toHaveBeenCalledWith({
      tenant: tenantId,
      _id: { $in: [replaceableOrderId] },
    });
  });

  it("keeps Stripe-backed orders out of the scheduled pending-order delete", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const deleteMany = vi
      .spyOn(Order, "deleteMany")
      .mockReturnValue(queryResult({ deletedCount: 0 }) as never);

    await createOrderRepository({ tenantId }).deleteUnpaidPending(
      [orderId],
      /pending/i,
    );

    expect(deleteMany).toHaveBeenCalledWith({
      tenant: String(tenantId),
      _id: { $in: [orderId] },
      isPaid: { $ne: true },
      $and: [
        {
          $or: [
            { status: /pending/i },
            { status: "failed_order" },
          ],
        },
        {
          $or: [
            { "stripe.sessionId": { $exists: false } },
            { "stripe.sessionId": "" },
            { "stripe.sessionId": null },
          ],
        },
      ],
    });
  });

  it("releases an expired Session using exact tenant, order, and Session scope", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    const courseBookingId = new mongoose.Types.ObjectId();
    const cartId = new mongoose.Types.ObjectId();
    const sessionId = "cs_expired";
    const connectedAccountId = "acct_tenant";
    const findOneAndUpdate = vi
      .spyOn(Order, "findOneAndUpdate")
      .mockReturnValue(
        findResult({
          _id: orderId,
          cart: cartId,
          workshopBookings: [bookingId],
          courseBookings: [
            {
              bookingId: courseBookingId,
              quantity: 2,
              capacityReserved: true,
            },
          ],
        }) as never,
      );
    const bookingDelete = vi
      .spyOn(Booking, "deleteMany")
      .mockReturnValue(queryResult({ deletedCount: 1 }) as never);
    const bookingUpdate = vi
      .spyOn(Booking, "updateMany")
      .mockReturnValue(queryResult({ modifiedCount: 1 }) as never);
    const cartDelete = vi
      .spyOn(Cart, "deleteOne")
      .mockReturnValue(queryResult({ deletedCount: 1 }) as never);
    const orderDelete = vi
      .spyOn(Order, "deleteOne")
      .mockReturnValue(queryResult({ deletedCount: 1 }) as never);

    await expect(
      checkoutRepository.releaseExpiredStripeOrder({
        tenantId,
        orderId,
        sessionId,
        connectedAccountId,
      }),
    ).resolves.toBe(true);

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: tenantId,
        _id: orderId,
        isPaid: false,
        status: { $in: ["pending_order", "cancelled_order"] },
        "stripe.sessionId": sessionId,
        "stripe.connectedAccountId": connectedAccountId,
      }),
      { $set: { status: "cancelled_order" } },
      { returnDocument: "after" },
    );
    expect(bookingDelete).toHaveBeenCalledWith({
      tenant: tenantId,
      _id: { $in: [bookingId] },
      orders: orderId,
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
    });
    expect(bookingUpdate).toHaveBeenCalledWith(
      {
        tenant: tenantId,
        _id: { $in: [courseBookingId] },
        "capacityReservations.order": orderId,
      },
      {
        $pull: {
          capacityReservations: { order: orderId },
        },
      },
    );
    expect(cartDelete).toHaveBeenCalledWith({
      tenant: tenantId,
      _id: cartId,
    });
    expect(orderDelete).not.toHaveBeenCalled();
  });

  it("releases a paid fulfillment claim without making the order terminal", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const updateOne = vi
      .spyOn(Order, "updateOne")
      .mockReturnValue(queryResult({ modifiedCount: 1 }) as never);

    await checkoutRepository.markOrderProcessingRetryable({
      tenantId,
      orderId,
      claimToken: "claim-retry",
      error: new Error("temporary outage"),
    });

    expect(updateOne).toHaveBeenCalledWith(
      {
        tenant: tenantId,
        _id: orderId,
        status: { $nin: ["processed_order", "cancelled_order"] },
        "stripe.processingClaimToken": "claim-retry",
      },
      {
        $set: {
          status: "pending_order",
          isPaid: true,
          "stripe.lastProcessingError": "temporary outage",
          "stripe.lastProcessingFailedAt": expect.any(Date),
        },
        $unset: {
          "stripe.processingClaimToken": 1,
          "stripe.processingEventId": 1,
          "stripe.processingClaimedAt": 1,
          "stripe.processingLeaseExpiresAt": 1,
        },
      },
    );
  });
});
