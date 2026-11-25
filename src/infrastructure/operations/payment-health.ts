import mongoose from "mongoose";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import { VoucherManagementRefund } from "@/modules/coupon/voucher-management-refund.model.js";
import { Order } from "@/modules/order/order.model.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import { PaymentRefundReconciliation } from "@/modules/tenant-payments/payment-refund-reconciliation.model.js";
import type { OperationsCheck } from "./operations.config.js";

export const PAYMENT_HEALTH_AGE_MS = 15 * 60_000;
export const PAYMENT_HEALTH_COUNT_LIMIT = 100;
export const PAYMENT_CHECK_IDS = ["payments.paid-unfulfilled", "payments.refunds-review", "payments.refunds-stale"] as const;

// Count matching records only up to a fixed cap. Never return account/order IDs
// or monetary/provider payloads. maxTimeMS + timeoutMS bound scans and checkout,
// including installations that have not yet added an operational index.
const limitedCount = async (collection: mongoose.Collection, filter: Record<string, unknown>): Promise<number> => {
  const rows = await collection.find(filter, {
    projection: { _id: 1 }, limit: PAYMENT_HEALTH_COUNT_LIMIT + 1,
    maxTimeMS: 1_000, timeoutMS: 1_500,
  }).toArray();
  return rows.length;
};

const summarize = async (id: string, reads: Promise<number>[]): Promise<OperationsCheck> => {
  try {
    const total = (await Promise.all(reads)).reduce((sum, count) => sum + count, 0);
    return {
      id, status: total > 0 ? "unhealthy" : "ok",
      reason: total > 0 ? "records_need_attention" : "healthy",
      count: Math.min(total, PAYMENT_HEALTH_COUNT_LIMIT), limit: PAYMENT_HEALTH_COUNT_LIMIT,
      countCapped: total > PAYMENT_HEALTH_COUNT_LIMIT,
    };
  } catch {
    return { id, status: "unavailable", reason: "query_unavailable" };
  }
};

export const readPaymentHealth = async (now = Date.now()): Promise<OperationsCheck[]> => {
  if (mongoose.connection.readyState !== 1) {
    return PAYMENT_CHECK_IDS.map((id) => ({ id, status: "unavailable", reason: "mongo_unavailable" }));
  }
  const cutoff = new Date(now - PAYMENT_HEALTH_AGE_MS);
  return Promise.all([
    summarize(PAYMENT_CHECK_IDS[0], [limitedCount(Order.collection, {
      isPaid: true, status: ORDER_STATUS.PENDING, updatedAt: { $lte: cutoff },
    })]),
    // Counts are records requiring review, not unique refund transactions: an
    // intent and its parent purchase may both require operator attention.
    summarize(PAYMENT_CHECK_IDS[1], [
      limitedCount(PaymentRefundReconciliation.collection, { reviewRequired: true }),
      limitedCount(BookingPaymentRefund.collection, { status: "review_required" }),
      limitedCount(VoucherManagementRefund.collection, { status: "review_required" }),
      limitedCount(CouponOrder.collection, { $or: [{ refundState: "manual_review" }, { refundFailureReviewRequired: true }] }),
      limitedCount(Order.collection, { $or: [
        { "bookingExtension.refundStatus": { $in: ["failed", "canceled"] } },
        { "waitlistRefund.status": { $in: ["failed", "canceled"] } },
      ] }),
    ]),
    // A provider-pending refund can be legitimate for days. Alert on an overdue
    // scheduled attempt/expired claim, not on its original creation time.
    summarize(PAYMENT_CHECK_IDS[2], [
      limitedCount(BookingPaymentRefund.collection, { $or: [
        { status: { $in: ["pending", "provider_pending"] }, nextAttemptAt: { $lte: cutoff } },
        { status: "processing", claimExpiresAt: { $lte: cutoff } },
      ] }),
      limitedCount(VoucherManagementRefund.collection, { $or: [
        { status: "pending", nextAttemptAt: { $lte: cutoff } },
        { status: "submitting", claimExpiresAt: { $lte: cutoff } },
      ] }),
    ]),
  ]);
};
