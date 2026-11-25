import { PaymentRefundReconciliation } from "@/modules/tenant-payments/payment-refund-reconciliation.model.js";
import mongoose from "mongoose";

import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "./order.model.js";
import {
  isStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

type Row = Record<string, any>;

/** Current net order value, including monetary stored-value tenders. This is
 * neither cash received nor revenue recognized when a product is delivered. */
export type OrderSalesAmounts = {
  status: "available" | "unavailable";
  currency: string | null;
  grossAmountMinor: number | null;
  refundedAmountMinor: number | null;
  netAmountMinor: number | null;
  reason: string | null;
};

const id = (value: any): string => String(value?._id ?? value ?? "");
const minor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const currencyOf = (value: unknown): StudioCommerceCurrency | null => {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return isStudioCommerceCurrency(currency) ? currency : null;
};
const bookingIds = (order: Row): string[] =>
  [...new Set([
    ...(order.lineItems ?? []).map((line: Row) => id(line.booking)),
    ...(order.workshopBookings ?? []).map(id),
    ...(order.courseBookings ?? []).map((line: Row) => id(line.bookingId)),
    id(order.bookingExtension?.bookingId),
  ].filter(Boolean))];

const unavailable = (currency: string | null, reason: string): OrderSalesAmounts => ({
  status: "unavailable", currency, grossAmountMinor: null,
  refundedAmountMinor: null, netAmountMinor: null, reason,
});

const snapshotProblem = (order: Row): string | null => {
  if (!currencyOf(order.currency)) return "missing_currency";
  // The schema defaults gross to zero, so gross alone is not evidence that a
  // historical order was free. Never fall back to a populated mutable cart.
  if (!minor(order.grossAmountMinor) || !Array.isArray(order.lineItems) ||
      !order.lineItems.length) return "missing_financial_snapshot";
  let sum = 0;
  for (const line of order.lineItems) {
    if (!minor(line.grossAmountMinor)) return "invalid_financial_snapshot";
    sum += line.grossAmountMinor;
  }
  if (!minor(sum) || sum !== order.grossAmountMinor)
    return "invalid_financial_snapshot";
  // Hours/entitlement redemptions and their reversals are not monetary sales.
  if ((order.paymentAllocations ?? []).some((row: Row) => row.method === "membership_credit") ||
      order.membershipRedemption?.ledgerEntryId || order.membershipRedemption?.membershipId ||
      order.membershipRedemption?.benefitKey)
    return "non_monetary_payment";
  return null;
};

type RefundEvidence = {
  providerRefunds?: Row[];
  paymentRefunds?: Row[];
  creditRefunds?: Row[];
  extensionBookingIds?: string[];
  unavailableReason?: string;
};

export const calculateOrderSalesAmounts = (
  order: Row,
  { providerRefunds = [], paymentRefunds = [], creditRefunds = [], extensionBookingIds = [], unavailableReason }: RefundEvidence = {},
): OrderSalesAmounts => {
  const currency = currencyOf(order.currency);
  const problem = snapshotProblem(order);
  if (problem) return unavailable(currency, problem);
  if (unavailableReason) return unavailable(currency, unavailableReason);
  const gross = order.grossAmountMinor as number;
  const orderId = id(order._id);
  const bookings = new Set(bookingIds(order));
  const extendedBookings = new Set(extensionBookingIds);
  const provider = order.refund;
  if (provider?.status === "review") return unavailable(currency, "provider_refund_review");
  const providerRows = providerRefunds.filter((row) => id(row.order) === orderId);
  const providerIds = new Map<string, number>(providerRows.flatMap((row) => (row.refunds ?? [])
    .filter((refund: Row) => refund.status === "succeeded").map((refund: Row) => [refund.id, refund.amountMinor] as [string, number])));
  let overlappingCardRefundMinor = 0;
  const returns = new Map<string, { amount: number; source: string }>();
  const bookingReturnFits = (booking: string, amount: unknown) => {
    const lines = order.lineItems.filter((line: Row) => id(line.booking) === booking);
    return Boolean(booking) && lines.length > 0 && minor(amount) &&
      amount <= lines.reduce((sum: number, line: Row) => sum + line.grossAmountMinor, 0);
  };
  const add = (key: string, amount: unknown, source: string): boolean => {
    if (!minor(amount) || returns.has(key)) return false;
    returns.set(key, { amount, source });
    return true;
  };

  for (const refund of paymentRefunds.filter((row) => id(row.order) === orderId)) {
    if (refund.status !== "succeeded") return unavailable(currency, "refund_pending_or_review");
    if (provider && Number(refund.cardAmountMinor) > 0) {
      if (providerIds.get(refund.refundId) !== refund.cardAmountMinor)
        return unavailable(currency, "provider_refund_identity_unavailable");
      overlappingCardRefundMinor += refund.cardAmountMinor;
    }
    if (currencyOf(refund.currency) !== currency || !bookingReturnFits(id(refund.booking), refund.amountMinor) ||
        !add(`booking:${id(refund.booking)}`, refund.amountMinor, "original_payment"))
      return unavailable(currency, "refund_allocation_unavailable");
  }

  for (const refund of creditRefunds) {
    const relatedOrder = id(refund.relatedOrder);
    const relatedBooking = id(refund.relatedBooking);
    if (relatedOrder !== orderId && !bookings.has(relatedBooking)) continue;
    // Some added-time cancellations aggregate several extension orders into a
    // single transaction. A booking link cannot allocate that money to orders.
    if (relatedOrder !== orderId) {
      // A Class session can contain many unrelated customer orders. A return
      // explicitly assigned to one of those orders does not affect this one.
      if (relatedOrder && !order.bookingExtension) continue;
      return unavailable(currency, "refund_allocation_unavailable");
    }
    if (order.bookingExtension || extendedBookings.has(relatedBooking))
      return unavailable(currency, "refund_allocation_unavailable");
    if (currencyOf(refund.currency) !== currency)
      return unavailable(currency, "refund_allocation_unavailable");
    let amount = refund.amountMinor;
    if (amount === null || amount === undefined) {
      try {
        if (typeof refund.amount !== "number" || !Number.isFinite(refund.amount) || refund.amount < 0)
          return unavailable(currency, "refund_allocation_unavailable");
        amount = toCurrencyMinorUnits(refund.amount, currency!);
      } catch {
        return unavailable(currency, "refund_allocation_unavailable");
      }
    }
    const key = relatedBooking ? `booking:${relatedBooking}` : `credit:${id(refund._id)}`;
    if (relatedBooking && !bookingReturnFits(relatedBooking, amount))
      return unavailable(currency, "refund_allocation_unavailable");
    if (!relatedBooking && !id(refund._id))
      return unavailable(currency, "refund_allocation_unavailable");
    if (!add(key, amount, "credits"))
      return unavailable(currency, "refund_allocation_unavailable");
  }

  const voucherFunded = Boolean(order.voucherRedemptions?.length) ||
    (order.paymentAllocations ?? []).some((row: Row) => row.method === "voucher");
  const cancellationIds = new Set<string>();
  for (const cancellation of order.courseCancellations ?? []) {
    const booking = id(cancellation.bookingId);
    if (!bookingReturnFits(booking, cancellation.refundAmountMinor) || cancellationIds.has(booking) ||
        currencyOf(cancellation.currency) !== currency)
      return unavailable(currency, "refund_allocation_unavailable");
    cancellationIds.add(booking);
    const key = `booking:${booking}`;
    const recorded = returns.get(key);
    if (recorded) {
      // courseCancellations mirrors the same original-payment/credit return.
      if (recorded.amount !== cancellation.refundAmountMinor)
        return unavailable(currency, "refund_allocation_unavailable");
    } else {
      if (voucherFunded) return unavailable(currency, "refund_allocation_unavailable");
      if (!add(key, cancellation.refundAmountMinor, "course_snapshot"))
        return unavailable(currency, "refund_allocation_unavailable");
    }
  }

  const specialReturns: Array<{ key: string; amount: number }> = [];
  const piece = order.pieceCheckout;
  if (piece) {
    if (!minor(piece.refundedAmountMinor) ||
        (piece.state === "refunded" && piece.refundedAmountMinor === 0))
      return unavailable(currency, "refund_allocation_unavailable");
    if (piece.refundedAmountMinor > 0)
      specialReturns.push({ key: "piece", amount: piece.refundedAmountMinor });
  }
  const waitlist = order.waitlistRefund;
  if (waitlist && (waitlist.status || waitlist.refundId || waitlist.amountMinor != null)) {
    if (waitlist.status !== "succeeded") return unavailable(currency, "refund_pending_or_review");
    if (!minor(waitlist.amountMinor)) return unavailable(currency, "refund_allocation_unavailable");
    specialReturns.push({ key: "waitlist", amount: waitlist.amountMinor });
  }
  const extension = order.bookingExtension;
  if (extension && (extension.refundStatus || extension.refundId)) {
    if (extension.refundStatus !== "succeeded") return unavailable(currency, "refund_pending_or_review");
    if (!minor(order.expectedAmountMinor)) return unavailable(currency, "refund_allocation_unavailable");
    specialReturns.push({ key: "extension", amount: order.expectedAmountMinor });
  }
  // These special refunds represent whole independent checkout flows. Mixed
  // evidence has no reliable event-level identity with which to deduplicate.
  if (specialReturns.length > 1 || (specialReturns.length && returns.size))
    return unavailable(currency, "refund_allocation_unavailable");
  for (const refund of specialReturns) add(refund.key, refund.amount, refund.key);
  let refunded = [...returns.values()].reduce((sum, row) => sum + row.amount, 0);
  if (provider) {
    if (!minor(provider.succeededAmountMinor)) return unavailable(currency, "provider_refund_review");
    // Existing extension/waitlist return snapshots mirror the same card money.
    if (specialReturns.length) {
      const existing = specialReturns[0];
      const refundId = existing.key === "waitlist" ? waitlist?.refundId : extension?.refundId;
      if (providerIds.get(refundId) !== existing.amount) return unavailable(currency, "provider_refund_identity_unavailable");
      overlappingCardRefundMinor += existing.amount;
    }
    refunded += provider.succeededAmountMinor - overlappingCardRefundMinor;
  }
  if (!minor(refunded) || refunded > gross)
    return unavailable(currency, "refund_exceeds_order_value");
  return {
    status: "available", currency, grossAmountMinor: gross,
    refundedAmountMinor: refunded, netAmountMinor: gross - refunded, reason: null,
  };
};

export const SALES_REFUND_ROW_LIMIT = 10_000;

/** Call only after the normal tenant/location authorization query. Refund
 * histories stay tenant-scoped and are projected to authorized order/bookings. */
export const attachOrderSalesAmounts = async <T extends Row>(
  tenantId: string, orders: T[],
): Promise<Array<T & { salesAmounts: OrderSalesAmounts }>> => {
  const validReferences = (order: Row) =>
    [id(order._id), ...bookingIds(order)].every((value) => mongoose.isValidObjectId(value));
  const annotate = (order: T, evidence: RefundEvidence = {}) => ({
    ...order,
    salesAmounts: calculateOrderSalesAmounts(order, validReferences(order) ? evidence : {
      unavailableReason: "invalid_financial_snapshot",
    }),
  });
  const eligible = orders.filter((order) => !snapshotProblem(order) && validReferences(order));
  if (!eligible.length)
    return orders.map((order) => annotate(order));
  const ids = eligible.map((order) => new mongoose.Types.ObjectId(id(order._id)));
  const bookings = [...new Set(eligible.flatMap(bookingIds))];
  if (bookings.length > SALES_REFUND_ROW_LIMIT)
    return orders.map((order) => annotate(order, {
      unavailableReason: "refund_query_limit",
    }));
  const tenant = new mongoose.Types.ObjectId(tenantId);
  const transactionMatch = {
    "transactions.type": "refund",
    $or: [
      { "transactions.relatedOrder": { $in: ids } },
      { "transactions.relatedBooking": { $in: bookings.map((value) => new mongoose.Types.ObjectId(value)) } },
    ],
  };
  let evidence: RefundEvidence;
  try {
    const [paymentRefunds, creditRefunds, extensions, providerRefunds] = await Promise.all([
      BookingPaymentRefund.find({ tenant, order: { $in: ids } })
        .select("_id order booking currency amountMinor cardAmountMinor voucherAmountMinor refundId status")
        .limit(SALES_REFUND_ROW_LIMIT + 1).lean().exec(),
      MoneyCredit.aggregate([
        { $match: { tenant, ...transactionMatch } },
        { $unwind: "$transactions" },
        { $match: transactionMatch },
        { $replaceRoot: { newRoot: "$transactions" } },
        { $project: { _id: 1, relatedOrder: 1, relatedBooking: 1, amount: 1, amountMinor: 1, currency: 1 } },
        { $limit: SALES_REFUND_ROW_LIMIT + 1 },
      ]).exec(),
      Order.find({ tenant, isPaid: true, "bookingExtension.bookingId": {
        $in: bookings.map((value) => new mongoose.Types.ObjectId(value)),
      } }).select("bookingExtension.bookingId")
        .limit(SALES_REFUND_ROW_LIMIT + 1).lean().exec(),
      eligible.some((order) => order.refund) ? PaymentRefundReconciliation.find({ tenant, order: { $in: ids } }).select("order refunds").limit(SALES_REFUND_ROW_LIMIT + 1).lean().exec() : Promise.resolve([]),
    ]);
    evidence = paymentRefunds.length > SALES_REFUND_ROW_LIMIT || creditRefunds.length > SALES_REFUND_ROW_LIMIT ||
      extensions.length > SALES_REFUND_ROW_LIMIT || providerRefunds.length > SALES_REFUND_ROW_LIMIT
      ? { unavailableReason: "refund_query_limit" }
      : { providerRefunds, paymentRefunds, creditRefunds, extensionBookingIds: extensions.map((row) => id(row.bookingExtension?.bookingId)) };
  } catch {
    // A failed ledger lookup must never appear as a verified zero refund.
    evidence = { unavailableReason: "refund_lookup_failed" };
  }
  return orders.map((order) => annotate(order, evidence));
};
