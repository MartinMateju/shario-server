import mongoose from "mongoose";
import { fulfillBookingExtensions } from "@/modules/booking/booking.extension.service.js";

import Booking from "@/modules/booking/booking.model.js";

type WorkshopFulfillmentOrder = {
  _id?: unknown;
  workshopBookings?: unknown[];
  bookingExtension?: unknown;
};

type WorkshopFulfillmentContext = {
  tenantId: string | mongoose.Types.ObjectId;
  session?: mongoose.ClientSession | null;
};

const toObjectId = (value: unknown): mongoose.Types.ObjectId =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));

export const processWorkshopBookingsAfterPayment = async (
  order: WorkshopFulfillmentOrder,
  { tenantId, session = null }: WorkshopFulfillmentContext,
) => {
  if (!order?._id) return false;
  if (order.bookingExtension) await fulfillBookingExtensions(order, { tenantId, session });

  const rawIds = Array.isArray(order.workshopBookings)
    ? order.workshopBookings
    : [];

  if (!rawIds.length) return true;

  if (rawIds.some((id) => !mongoose.Types.ObjectId.isValid(String(id)))) {
    throw new Error(
      `Open Studio bookings for order ${String(order._id)} contain an invalid reference.`,
    );
  }

  const ids = [
    ...new Map(
      rawIds.map((id) => {
        const objectId = toObjectId(id);
        return [String(objectId), objectId] as const;
      }),
    ).values(),
  ];
  const orderId = toObjectId(order._id);
  const tenant = toObjectId(tenantId);
  const now = new Date();

  await Booking.updateMany(
    {
      tenant,
      _id: { $in: ids },
      tag: { $in: ["open-studio", "workshop"] },
      orders: orderId,
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: { $gt: now },
    },
    {
      $set: {
        paymentStatus: "CONFIRMED",
        status: "processed",
        paymentConfirmedAt: now,
      },
      $unset: { paymentExpiresAt: "" },
    },
    { session },
  ).exec();

  const fulfilledCount = await Booking.countDocuments({
    tenant,
    _id: { $in: ids },
    tag: { $in: ["open-studio", "workshop"] },
    orders: orderId,
    paymentStatus: "CONFIRMED",
    status: { $in: ["processed", "delivered"] },
  })
    .session(session)
    .exec();

  if (fulfilledCount !== ids.length) {
    throw new Error(
      `Not all Open Studio bookings for order ${String(orderId)} could be confirmed.`,
    );
  }

  return true;
};
