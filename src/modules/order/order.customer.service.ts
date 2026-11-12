import mongoose from "mongoose";

import { accessCodeRepository } from "@/modules/access-codes/access-code.repository.js";
import BookingModel from "@/modules/booking/booking.model.js";
import {
  assertCustomerAccount,
  serializeCustomerBooking,
} from "@/modules/booking/booking.customer.service.js";
import { notFound } from "@/shared/http/httpErrors.js";

import OrderModel from "./order.model.js";

const toId = (value: unknown): string =>
  String((value as { _id?: unknown } | null)?._id ?? value ?? "").trim();

export const getMyOrderConfirmation = async ({
  tenantId,
  userId,
  orderId,
}: {
  tenantId: string;
  userId: string;
  orderId: string;
}) => {
  await assertCustomerAccount({
    tenantId,
    userId,
    allowWorkspaceIdentity: true,
  });

  if (!mongoose.isValidObjectId(orderId)) {
    notFound({
      message: "Order confirmation not found.",
      code: "CUSTOMER_ORDER_NOT_FOUND",
    });
  }

  const order = await OrderModel.findOne({
    _id: orderId,
    tenant: tenantId,
    createdBy: userId,
  })
    .select(
      "_id status currency grossAmountMinor expectedAmountMinor paidAmountMinor isPaid paidAt lineItems paymentAllocations appliedDiscount workshopBookings courseBookings createdAt",
    )
    .lean()
    .exec();

  if (!order) {
    notFound({
      message: "Order confirmation not found.",
      code: "CUSTOMER_ORDER_NOT_FOUND",
    });
  }

  const courseQuantities = new Map(
    (order.courseBookings || []).map((entry: any) => [
      toId(entry.bookingId),
      Number(entry.quantity) || 1,
    ]),
  );
  const bookingIds = [
    ...(order.workshopBookings || []).map(toId),
    ...courseQuantities.keys(),
  ].filter((id) => mongoose.isValidObjectId(id));
  const bookings = bookingIds.length
    ? await BookingModel.find({
        tenant: tenantId,
        _id: { $in: bookingIds },
      })
        .select(
          "_id bookingProduct location start end status paymentStatus paymentExpiresAt numberOfGuests bookingType plannedActivity tag accessCodeDelivery accessCodeCustomerModificationLockedAt",
        )
        .populate([
          {
            path: "bookingProduct",
            select: "name description type imageSrc currency",
          },
          {
            path: "location",
            select:
              "name slug address booking.timezone booking.doorCodeMinutesBefore access.publicInstructions",
          },
        ])
        .sort({ start: 1 })
        .lean()
        .exec()
    : [];
  const accessCodeValidity =
    await accessCodeRepository.findUsableLocationValidity(
      tenantId,
      bookings.map((booking) => toId(booking.location)).filter(Boolean),
    );
  const status = String(order.status || "pending_order");

  return {
    orderId: toId(order),
    status,
    isPaid: order.isPaid === true,
    terminal: status !== "pending_order",
    processing: status === "pending_order" && order.isPaid === true,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    currency: order.currency,
    totals: {
      grossAmountMinor: Number(order.grossAmountMinor || 0),
      expectedAmountMinor: Number(order.expectedAmountMinor || 0),
      paidAmountMinor:
        order.paidAmountMinor == null
          ? null
          : Number(order.paidAmountMinor),
    },
    paymentAllocations: (order.paymentAllocations || []).map(
      (allocation: any) => ({
        method: allocation.method,
        amountMinor: Number(allocation.amountMinor || 0),
      }),
    ),
    discount: order.appliedDiscount
      ? {
          source: order.appliedDiscount.source,
          label: order.appliedDiscount.label,
          amountMinor: order.appliedDiscount.amountMinor,
          percentageBps: order.appliedDiscount.percentageBps,
        }
      : null,
    items: (order.lineItems || []).map((line: any) => ({
      productId: toId(line.product) || null,
      description: line.description,
      quantity: Number(line.quantity),
      unitGrossMinor: Number(line.unitGrossMinor),
      grossAmountMinor: Number(line.grossAmountMinor),
    })),
    bookings: bookings.map((booking) =>
      serializeCustomerBooking(
        booking,
        courseQuantities.get(toId(booking)),
        (() => {
          const expiresAt = accessCodeValidity.get(toId(booking.location));
          const bookingEnd = new Date(booking.end).getTime();

          return Boolean(
            expiresAt &&
              Number.isFinite(bookingEnd) &&
              expiresAt.getTime() > bookingEnd,
          );
        })(),
        false,
        false,
        { hasPaidOrder: order.isPaid === true },
      ),
    ),
  };
};
