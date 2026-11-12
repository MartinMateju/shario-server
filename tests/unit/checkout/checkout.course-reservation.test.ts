import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconcileWaitlistAfterDirectCourseBooking: vi.fn(),
}));

vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  reconcileWaitlistAfterDirectCourseBooking:
    mocks.reconcileWaitlistAfterDirectCourseBooking,
}));

import Booking from "@/modules/booking/booking.model.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { processCourseBookingsAfterPayment } from "@/modules/checkout/services/checkout.webhook.service.js";

const queryResult = <T>(value: T) => ({
  exec: vi.fn().mockResolvedValue(value),
});

describe("course capacity reservation lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.reconcileWaitlistAfterDirectCourseBooking.mockReset();
    mocks.reconcileWaitlistAfterDirectCourseBooking.mockResolvedValue(
      undefined,
    );
  });

  it("claims capacity with an atomic predicate and append", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const now = new Date("2026-07-22T10:00:00.000Z");
    const minimumStart = new Date("2026-07-22T10:30:00.000Z");
    const expiresAt = new Date("2026-07-23T10:30:00.000Z");
    const updateOne = vi
      .spyOn(Booking, "updateOne")
      .mockReturnValue(queryResult({ modifiedCount: 1 }) as never);

    await checkoutRepository.reserveCourseCapacity({
      tenantId,
      orderId,
      now,
      minimumStart,
      expiresAt,
      reservations: [
        {
          bookingId,
          productId,
          quantity: 2,
          capacity: 8,
        },
      ],
    });

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, pipeline] = updateOne.mock.calls[0];

    expect(filter).toMatchObject({
      tenant: tenantId,
      _id: bookingId,
      bookingProduct: productId,
      tag: { $in: ["class", "course"] },
      start: { $gt: minimumStart },
      $expr: {
        $lte: [expect.any(Object), 8],
      },
    });
    expect(pipeline).toEqual([
      {
        $set: {
          capacityReservations: {
            $concatArrays: [
              expect.any(Object),
              [{ order: orderId, quantity: 2, expiresAt }],
            ],
          },
        },
      },
    ]);
  });

  it("rolls back this order's earlier holds when a slot cannot be claimed", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    vi.spyOn(Booking, "updateOne").mockReturnValue(
      queryResult({ modifiedCount: 0 }) as never,
    );
    const rollback = vi
      .spyOn(Booking, "updateMany")
      .mockReturnValue(queryResult({ modifiedCount: 1 }) as never);

    await expect(
      checkoutRepository.reserveCourseCapacity({
        tenantId,
        orderId,
        expiresAt: new Date(Date.now() + 60_000),
        reservations: [
          {
            bookingId,
            productId,
            quantity: 2,
            capacity: 8,
          },
        ],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CHECKOUT_COURSE_CAPACITY_EXCEEDED",
    });

    expect(rollback).toHaveBeenCalledWith(
      {
        tenant: tenantId,
        "capacityReservations.order": orderId,
      },
      {
        $pull: {
          capacityReservations: { order: orderId },
        },
      },
    );
  });

  it("atomically consumes a paid order's hold while adding participants", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    const updateOne = vi
      .spyOn(Booking, "updateOne")
      .mockReturnValue(queryResult({ modifiedCount: 1 }) as never);

    await processCourseBookingsAfterPayment(
      {
        _id: orderId,
        createdBy: "507f1f77bcf86cd799439099",
        customer: {
          firstname: "Martin",
          lastname: "Mateju",
          customId: "U-1",
          email: "martin@example.test",
        },
        courseBookings: [
          {
            bookingId,
            quantity: 2,
            capacityReserved: true,
          },
        ],
      },
      { tenantId: String(tenantId) },
    );

    expect(mocks.reconcileWaitlistAfterDirectCourseBooking).toHaveBeenCalledWith({
      tenantId: String(tenantId),
      sessionId: String(bookingId),
      orderId: String(orderId),
      customerId: "507f1f77bcf86cd799439099",
      email: "martin@example.test",
      mongoSession: null,
    });
    expect(updateOne).toHaveBeenCalledWith(
      {
        tenant: tenantId,
        _id: bookingId,
        tag: { $in: ["class", "course"] },
        "participants.order": { $ne: orderId },
        capacityReservations: {
          $elemMatch: {
            order: orderId,
            quantity: 2,
          },
        },
      },
      expect.objectContaining({
        $inc: { numberOfGuests: 2 },
        $addToSet: { orders: orderId },
        $pull: { capacityReservations: { order: orderId } },
      }),
      { session: null },
    );
  });
  it("fulfills guest seats without linking the typed email to an existing waitlist", async () => {
    const update = vi.spyOn(Booking, "updateOne")
      .mockReturnValue(queryResult({ modifiedCount: 1 }) as never);
    await processCourseBookingsAfterPayment({
      _id: new mongoose.Types.ObjectId(), createdBy: new mongoose.Types.ObjectId(),
      guestCourseCheckout: { version: 1 },
      customer: { firstname: "Guest", lastname: "Buyer", email: "registered@example.test" },
      courseBookings: [{ bookingId: new mongoose.Types.ObjectId(), quantity: 1, capacityReserved: true }],
    } as any, { tenantId: String(new mongoose.Types.ObjectId()) });
    expect(update).toHaveBeenCalledOnce();
    expect(mocks.reconcileWaitlistAfterDirectCourseBooking).not.toHaveBeenCalled();
  });
});
