import mongoose, { type ClientSession } from "mongoose";

import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { Order } from "@/modules/order/order.model.js";
import { WaitlistAuditModel } from "@/modules/waitlist/waitlist.model.js";
import { WAITLIST_ADMIN_ACTION } from "@/modules/waitlist/waitlist.constants.js";
import { promoteWaitlistEntry } from "@/modules/waitlist/waitlist.service.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import type { CommunicationEmailLogDocument } from "@/modules/communication-email-logs/communication-email-log.types.js";
import {
  dispatchBookingLifecycleEmailSafely,
  recordCourseParticipantCancellationEmailInSession,
} from "./booking.customer-notification.service.js";
import {
  fromCurrencyMinorUnits,
  normalizeStudioCommerceCurrency,
} from "@/shared/money/currency.js";

import Booking from "../booking.model.js";
import { BookingPaymentRefund } from "../booking-payment-refund.model.js";
import {
  hasVoucherPayment,
  refundBookingOriginalPaymentInSession,
  serializeBookingPaymentRefund,
} from "./booking-payment-refund.service.js";

const objectId = (value: unknown): mongoose.Types.ObjectId =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));

const lineRefundMinor = (order: any, sessionId: string): number => {
  const lines = (order.lineItems ?? []).filter(
    (line: any) => String(line.booking ?? "") === sessionId,
  );
  if (!lines.length) {
    conflict({
      message:
        "This paid order has no immutable Class line snapshot and requires manual review.",
      code: "COURSE_PARTICIPANT_REFUND_SNAPSHOT_MISSING",
    });
  }
  const total = lines.reduce(
    (sum: number, line: any) => sum + Number(line.grossAmountMinor),
    0,
  );
  if (!Number.isSafeInteger(total) || total < 0) {
    conflict({
      message: "The saved Class refund amount is invalid.",
      code: "COURSE_PARTICIPANT_REFUND_SNAPSHOT_INVALID",
    });
  }
  return total;
};

const withTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

/**
 * Removes every seat purchased by one paid order for one Class session. The
 * immutable invoice line is returned to its saved voucher/card sources for
 * voucher-funded purchases; historical orders retain studio-credit refunds. Membership-credit redemptions
 * fail closed because partially reversing a multi-session entitlement would
 * require a separate commerce policy.
 */
export const cancelPaidCourseParticipants = async ({
  tenantId,
  sessionId,
  orderId,
  actorUserId,
  reason,
  now = new Date(),
}: {
  tenantId: string;
  sessionId: string;
  orderId: string;
  actorUserId: string;
  reason: string;
  now?: Date;
}) => {
  let lifecycleEmail: CommunicationEmailLogDocument | null = null;
  const result = await withTransaction(async (mongoSession) => {
    // A transaction retry must never dispatch a log from its aborted attempt.
    lifecycleEmail = null;
    const courseSession = await Booking.findOne({
      _id: objectId(sessionId),
      tenant: objectId(tenantId),
      tag: { $in: ["class", "course"] },
      archive: { $ne: true },
      status: { $nin: ["cancelled", "canceled"] } as any,
      start: { $gt: now },
    })
      .select("_id numberOfGuests participants orders start attendanceManaged")
      .session(mongoSession)
      .exec();
    if (!courseSession) {
      notFound({
        message: "Future Class session not found.",
        code: "COURSE_SESSION_NOT_FOUND",
      });
    }

    const order = await Order.findOne({
      _id: objectId(orderId),
      tenant: objectId(tenantId),
      isPaid: true,
      status: "processed_order",
      courseBookings: {
        $elemMatch: { bookingId: objectId(sessionId) },
      },
    })
      .select(
        "_id createdBy currency lineItems paymentAllocations voucherRedemptions courseBookings courseCancellations",
      )
      .session(mongoSession)
      .exec();
    if (!order) {
      notFound({
        message: "Paid Class order not found.",
        code: "COURSE_PARTICIPANT_ORDER_NOT_FOUND",
      });
    }

    const previous = (order.courseCancellations ?? []).find(
      (value: any) => String(value.bookingId) === sessionId,
    );
    if (previous) {
      const savedRefund = hasVoucherPayment(order)
        ? await BookingPaymentRefund.findOne({
            _id: `${tenantId}:${orderId}:${sessionId}`,
            tenant: objectId(tenantId),
          })
            .session(mongoSession)
            .lean()
            .exec()
        : null;
      if (hasVoucherPayment(order) && !savedRefund) {
        conflict({
          code: "BOOKING_PAYMENT_REFUND_REVIEW_REQUIRED",
          message:
            "The existing cancellation has no original payment refund record.",
        });
      }
      return {
        idempotent: true,
        removedParticipants: Number(
          previous.releasedQuantity ?? previous.quantity,
        ),
        refundAmountMinor: Number(previous.refundAmountMinor),
        currency: normalizeStudioCommerceCurrency(previous.currency),
        originalPaymentRefund: savedRefund
          ? serializeBookingPaymentRefund(savedRefund)
          : null,
      };
    }

    const participants = (courseSession.participants ?? []).filter(
      (participant: any) => String(participant.order ?? "") === orderId,
    );
    if (!participants.length) {
      conflict({
        message: "This order has no active participants in the Class.",
        code: "COURSE_PARTICIPANT_ALREADY_REMOVED",
      });
    }

    const refundAmountMinor = lineRefundMinor(order, sessionId);
    const currency = normalizeStudioCommerceCurrency(order.currency);
    if (
      refundAmountMinor > 0 &&
      (order.paymentAllocations ?? []).some(
        (allocation: any) => allocation.method === "membership_credit",
      )
    ) {
      conflict({
        message:
          "Membership-credit Class cancellations require manual entitlement review.",
        code: "COURSE_PARTICIPANT_MEMBERSHIP_REFUND_REVIEW",
      });
    }

    // Attendance removal never forfeits the purchased order/refund entitlement.
    // Only still-active seats are released here; otherwise capacity would be
    // decremented a second time after an attendance-only adjustment.
    const removedParticipants = participants.filter(
      (participant: any) => participant.attendanceStatus !== "removed",
    ).length;
    const purchasedQuantity = participants.length;
    const removed = await Booking.updateOne(
      {
        _id: courseSession._id,
        tenant: objectId(tenantId),
        "participants.order": order._id,
        numberOfGuests: { $gte: removedParticipants },
      },
      {
        ...(courseSession.attendanceManaged
          ? {
              $set: {
                "participants.$[p].attendanceStatus": "removed",
                "participants.$[p].removedAt": now,
                "participants.$[p].removedBy": objectId(actorUserId),
              },
              $pull: { orders: order._id },
            }
          : {
              $pull: { participants: { order: order._id }, orders: order._id },
            }),
        $inc: {
          numberOfGuests: -removedParticipants,
          waitlistJoinRevision: 1,
        },
      },
      {
        session: mongoSession,
        ...(courseSession.attendanceManaged
          ? { arrayFilters: [{ "p.order": order._id }] }
          : {}),
      },
    ).exec();
    if (removed.modifiedCount !== 1) {
      conflict({
        message: "Class participants changed during cancellation.",
        code: "COURSE_PARTICIPANT_CANCELLATION_CONFLICT",
      });
    }

    let creditResult: any = null;
    const originalPaymentRefund = hasVoucherPayment(order)
      ? await refundBookingOriginalPaymentInSession({
          tenantId,
          orderId,
          bookingId: sessionId,
          actorId: actorUserId,
          reason,
          session: mongoSession,
          now,
        })
      : null;
    if (refundAmountMinor > 0 && !originalPaymentRefund) {
      creditResult = await moneyCreditService.incrementMoneyCredits({
        tenantId,
        userId: String(order.createdBy),
        amount: fromCurrencyMinorUnits(refundAmountMinor, currency),
        currency,
        transaction: {
          type: MONEY_CREDIT_TRANSACTION_TYPE.REFUND,
          description: "Refund for an administratively cancelled Class place",
          relatedBooking: objectId(sessionId),
          relatedOrder: order._id,
          adminId: objectId(actorUserId),
          reason,
          idempotencyKey: `course-participant:${orderId}:${sessionId}:refund`,
        },
        session: mongoSession,
      });
    }

    order.courseCancellations.push({
      bookingId: objectId(sessionId),
      quantity: purchasedQuantity,
      releasedQuantity: removedParticipants,
      refundAmountMinor,
      currency,
      actor: objectId(actorUserId),
      reason,
      refundedAt: now,
    });
    await order.save({ session: mongoSession });

    lifecycleEmail = await recordCourseParticipantCancellationEmailInSession(
      {
        tenantId,
        userId: String(order.createdBy),
        bookingId: sessionId,
        orderId,
        refundAmount: fromCurrencyMinorUnits(refundAmountMinor, currency),
        refundCurrency: currency,
        refundType: originalPaymentRefund
          ? "original_payment"
          : "money_credits",
        refundCardAmountMinor: originalPaymentRefund?.cardAmountMinor,
        refundVoucherAmountMinor: originalPaymentRefund?.voucherAmountMinor,
      },
      mongoSession,
    );

    await WaitlistAuditModel.create(
      [
        {
          tenant: objectId(tenantId),
          courseSession: objectId(sessionId),
          actor: objectId(actorUserId),
          action: WAITLIST_ADMIN_ACTION.PARTICIPANT_REMOVED,
          reason,
          before: { booked: Number(courseSession.numberOfGuests) },
          after: {
            booked: Number(courseSession.numberOfGuests) - removedParticipants,
            orderId,
            removedParticipants,
            refundAmountMinor,
            currency,
          },
        },
      ],
      { session: mongoSession },
    );

    return {
      idempotent: false,
      removedParticipants,
      refundAmountMinor,
      currency,
      newCreditBalance: creditResult?.newBalance ?? null,
      originalPaymentRefund,
    };
  });

  await dispatchBookingLifecycleEmailSafely(lifecycleEmail);

  if (!result.idempotent) {
    for (let index = 0; index < result.removedParticipants; index += 1) {
      const promoted = await promoteWaitlistEntry({
        tenantId,
        sessionId,
        automatic: true,
        now,
      }).catch(() => null);
      if (!promoted) break;
    }
  }

  return {
    sessionId,
    orderId,
    removedParticipants: result.removedParticipants,
    refund: result.originalPaymentRefund
      ? {
          ...result.originalPaymentRefund,
          amount: fromCurrencyMinorUnits(
            result.refundAmountMinor,
            result.currency,
          ),
        }
      : {
          amount: fromCurrencyMinorUnits(
            result.refundAmountMinor,
            result.currency,
          ),
          amountMinor: result.refundAmountMinor,
          currency: result.currency,
          method: "money_credits" as const,
          newBalance: result.newCreditBalance ?? null,
        },
    idempotent: result.idempotent,
  };
};
