import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { processWorkshopBookingsAfterPayment } from "@/modules/checkout/services/checkout.workshop-fulfillment.service.js";

const updateQuery = (value: unknown) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const countQuery = (value: number) => ({
  session: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

describe("Open Studio checkout fulfillment", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("requires every expected tenant/order-linked booking to be confirmed", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingIds = [
      new mongoose.Types.ObjectId(),
      new mongoose.Types.ObjectId(),
    ];
    vi.spyOn(Booking, "updateMany").mockReturnValue(
      updateQuery({ modifiedCount: 1 }) as never,
    );
    vi.spyOn(Booking, "countDocuments").mockReturnValue(countQuery(1) as never);

    await expect(
      processWorkshopBookingsAfterPayment(
        { _id: orderId, workshopBookings: bookingIds },
        { tenantId: String(tenantId) },
      ),
    ).rejects.toThrow(/Not all Open Studio bookings/);
  });

  it("confirms only bookings linked to the paid order", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    const updateMany = vi
      .spyOn(Booking, "updateMany")
      .mockReturnValue(updateQuery({ modifiedCount: 1 }) as never);
    vi.spyOn(Booking, "countDocuments").mockReturnValue(countQuery(1) as never);

    await expect(
      processWorkshopBookingsAfterPayment(
        { _id: orderId, workshopBookings: [bookingId] },
        { tenantId: String(tenantId) },
      ),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith(
      {
        tenant: tenantId,
        _id: { $in: [bookingId] },
        tag: { $in: ["open-studio", "workshop"] },
        orders: orderId,
        status: "pending",
        paymentStatus: "PENDING_PAYMENT",
        paymentExpiresAt: { $gt: expect.any(Date) },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          paymentStatus: "CONFIRMED",
          status: "processed",
        }),
      }),
      { session: null },
    );
  });

  it("treats already-confirmed linked bookings as idempotently fulfilled", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    vi.spyOn(Booking, "updateMany").mockReturnValue(
      updateQuery({ modifiedCount: 0 }) as never,
    );
    vi.spyOn(Booking, "countDocuments").mockReturnValue(countQuery(1) as never);

    await expect(
      processWorkshopBookingsAfterPayment(
        { _id: orderId, workshopBookings: [bookingId] },
        { tenantId: String(tenantId) },
      ),
    ).resolves.toBe(true);
  });

  it("does not confirm a pending booking after its payment window expired", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    const updateMany = vi
      .spyOn(Booking, "updateMany")
      .mockReturnValue(updateQuery({ modifiedCount: 0 }) as never);
    vi.spyOn(Booking, "countDocuments").mockReturnValue(countQuery(0) as never);

    await expect(
      processWorkshopBookingsAfterPayment(
        { _id: orderId, workshopBookings: [bookingId] },
        { tenantId: String(tenantId) },
      ),
    ).rejects.toThrow(/Not all Open Studio bookings/);

    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: { $gt: expect.any(Date) },
    });
  });

  it("rejects malformed persisted booking references", async () => {
    await expect(
      processWorkshopBookingsAfterPayment(
        {
          _id: new mongoose.Types.ObjectId(),
          workshopBookings: ["not-an-object-id"],
        },
        { tenantId: String(new mongoose.Types.ObjectId()) },
      ),
    ).rejects.toThrow(/invalid reference/);
  });
});
