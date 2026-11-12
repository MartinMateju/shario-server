import { createHash, randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import type Stripe from "stripe";
import { Order } from "@/modules/order/order.model.js";
import { reverseVoucherInSession } from "@/modules/coupon/voucher-lifecycle.service.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
  getTenantPaymentStripeLivemode,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import { BookingPaymentRefund } from "../booking-payment-refund.model.js";

const id = (value: any) => String(value?._id ?? value ?? "");
const objectId = (value: string) => new mongoose.Types.ObjectId(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = (message: string): never =>
  conflict({ message, code: "BOOKING_PAYMENT_REFUND_REVIEW_REQUIRED" });

export const hasVoucherPayment = (order: any): boolean =>
  Boolean(
    order?.voucherRedemptions?.length ||
    order?.paymentAllocations?.some((row: any) => row.method === "voucher"),
  );

/** Financial amounts come exclusively from the paid, immutable order snapshot.
 * Each reservation funds one saved line. Cancelling one session in a multi-
 * session order returns only that session's value/quantity and card remainder. */
export function resolveOriginalPaymentRefund(order: any, bookingId: string) {
  if (!hasVoucherPayment(order)) return null;
  if (order.isPaid !== true || order.status !== "processed_order")
    invalid("Only a processed paid order can be refunded.");
  const currency = normalizeStudioCommerceCurrency(order.currency);
  const lines = order.lineItems ?? [];
  const redemptions = order.voucherRedemptions ?? [];
  if (
    !lines.length ||
    !redemptions.length ||
    !integer(order.grossAmountMinor) ||
    !integer(order.expectedAmountMinor)
  )
    invalid("Voucher payment snapshots are incomplete.");
  const lineTotal = lines.reduce((sum: number, line: any) => {
    if (!integer(line.grossAmountMinor))
      invalid("The saved paid line amount is invalid.");
    return sum + line.grossAmountMinor;
  }, 0);
  if (!Number.isSafeInteger(lineTotal) || lineTotal !== order.grossAmountMinor)
    invalid("The saved invoice lines do not match the paid order total.");
  const reservationIds = new Set<string>();
  const perLine = new Map<number, number>();
  for (const row of redemptions) {
    if (
      !integer(row.lineIndex) ||
      row.lineIndex >= lines.length ||
      !integer(row.amountMinor) ||
      !integer(row.quantity) ||
      !integer(row.appliedAmountMinor) ||
      row.appliedAmountMinor <= 0 ||
      !id(row.couponId) ||
      !row.reservationId ||
      reservationIds.has(row.reservationId)
    )
      invalid("The saved voucher funding allocation is invalid.");
    if (
      row.amountMinor > 0 === row.quantity > 0 ||
      (row.amountMinor > 0 && row.amountMinor !== row.appliedAmountMinor)
    )
      invalid("Voucher funding does not match its reserved entitlement.");
    reservationIds.add(row.reservationId);
    perLine.set(
      row.lineIndex,
      (perLine.get(row.lineIndex) ?? 0) + row.appliedAmountMinor,
    );
    if (perLine.get(row.lineIndex)! > lines[row.lineIndex].grossAmountMinor)
      invalid("Voucher funding exceeds the paid line amount.");
  }
  const voucherTotal = [...perLine.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  );
  let cardAllocation = 0;
  let voucherAllocation = 0;
  for (const allocation of order.paymentAllocations ?? []) {
    if (!integer(allocation.amountMinor))
      invalid("The saved payment allocation is invalid.");
    if (allocation.method === "stripe")
      cardAllocation += allocation.amountMinor;
    else if (allocation.method === "voucher")
      voucherAllocation += allocation.amountMinor;
    else if (allocation.amountMinor > 0)
      invalid(
        "This voucher payment contains an unsupported additional funding source.",
      );
  }
  if (
    voucherAllocation !== voucherTotal ||
    cardAllocation !== order.expectedAmountMinor ||
    cardAllocation + voucherTotal !== order.grossAmountMinor
  )
    invalid("The saved original payment sources do not match the paid total.");
  const indexes = lines.flatMap((line: any, index: number) =>
    id(line.booking) === bookingId ? [index] : [],
  );
  if (!indexes.length)
    invalid("The paid order has no immutable line for this booking.");
  const selected = redemptions.filter((row: any) =>
    indexes.includes(row.lineIndex),
  );
  const amountMinor = indexes.reduce(
    (sum: number, index: number) => sum + lines[index].grossAmountMinor,
    0,
  );
  const voucherAmountMinor = selected.reduce(
    (sum: number, row: any) => sum + row.appliedAmountMinor,
    0,
  );
  const voucherQuantity = selected.reduce(
    (sum: number, row: any) => sum + row.quantity,
    0,
  );
  const cardAmountMinor = amountMinor - voucherAmountMinor;
  if (
    cardAmountMinor > 0 &&
    (!String(order.stripe?.paymentIntentId).startsWith("pi_") ||
      !String(order.stripe?.connectedAccountId).startsWith("acct_") ||
      typeof order.stripe?.livemode !== "boolean")
  )
    invalid("The original card payment cannot be identified safely.");
  return {
    currency,
    amountMinor,
    voucherAmountMinor,
    voucherQuantity,
    cardAmountMinor,
    redemptions: selected,
  };
}

export const serializeBookingPaymentRefund = (row: any) => ({
  method: "original_payment" as const,
  amountMinor: Number(row.amountMinor),
  voucherAmountMinor: Number(row.voucherAmountMinor),
  voucherQuantity: Number(row.voucherQuantity),
  cardAmountMinor: Number(row.cardAmountMinor),
  currency: row.currency,
  status: row.status as string,
});

export const getBookingPaymentRefunds = async ({
  tenantId,
  bookingId,
  session,
}: {
  tenantId: string;
  bookingId: string;
  session?: ClientSession;
}) => {
  const query = BookingPaymentRefund.find({
    tenant: objectId(tenantId),
    booking: objectId(bookingId),
  }).sort({ createdAt: 1 });
  if (session) query.session(session);
  return (await query.lean().exec()).map(serializeBookingPaymentRefund);
};

/** Called only inside the cancellation transaction. No provider I/O occurs here. */
export async function refundBookingOriginalPaymentInSession({
  tenantId,
  orderId,
  bookingId,
  actorId,
  reason,
  session,
  now = new Date(),
}: {
  tenantId: string;
  orderId: string;
  bookingId: string;
  actorId: string;
  reason: string;
  session: ClientSession;
  now?: Date;
}) {
  if (!session?.inTransaction())
    throw new Error("Booking refunds require a transaction.");
  await acquireVoucherTenantMutationLock(tenantId, session);
  const order = await Order.findOne({
    _id: objectId(orderId),
    tenant: objectId(tenantId),
    isPaid: true,
  })
    .session(session)
    .lean()
    .exec();
  if (!order) notFound("Paid order not found.");
  const plan = resolveOriginalPaymentRefund(order, bookingId);
  if (!plan) return null;
  const operationId = `${tenantId}:${orderId}:${bookingId}`;
  const previous = await BookingPaymentRefund.findOne({
    _id: operationId,
    tenant: objectId(tenantId),
  })
    .session(session)
    .lean()
    .exec();
  if (previous) {
    for (const key of [
      "currency",
      "amountMinor",
      "voucherAmountMinor",
      "voucherQuantity",
      "cardAmountMinor",
    ]) {
      if (previous[key] !== plan[key])
        invalid("The saved cancellation refund differs from this paid order.");
    }
    return { ...serializeBookingPaymentRefund(previous), idempotent: true };
  }
  for (const row of plan.redemptions) {
    await reverseVoucherInSession(
      {
        tenantId,
        couponId: id(row.couponId),
        reservationId: row.reservationId,
        operationId: `booking-refund:${orderId}:${bookingId}:${row.lineIndex}`,
        referenceId: orderId,
        currency: plan.currency,
        actorId,
        reason,
        amountMinor: row.amountMinor,
        quantity: row.quantity,
      },
      session,
    );
  }
  const [record] = await BookingPaymentRefund.create(
    [
      {
        _id: operationId,
        tenant: objectId(tenantId),
        order: order._id,
        booking: objectId(bookingId),
        customer: order.createdBy,
        actor: objectId(actorId),
        reason,
        currency: plan.currency,
        amountMinor: plan.amountMinor,
        voucherAmountMinor: plan.voucherAmountMinor,
        voucherQuantity: plan.voucherQuantity,
        cardAmountMinor: plan.cardAmountMinor,
        paymentIntentId: order.stripe?.paymentIntentId ?? "",
        connectedAccountId: order.stripe?.connectedAccountId ?? "",
        livemode: order.stripe?.livemode ?? null,
        status: plan.cardAmountMinor > 0 ? "pending" : "succeeded",
        nextAttemptAt: plan.cardAmountMinor > 0 ? now : null,
        completedAt: plan.cardAmountMinor > 0 ? null : now,
      },
    ],
    { session },
  );
  return { ...serializeBookingPaymentRefund(record), idempotent: false };
}

class RefundReviewRequired extends Error {}
const review = (message: string): never => {
  throw new RefundReviewRequired(message);
};
const refundKey = (record: any) =>
  `booking-refund:${createHash("sha256").update(String(record._id)).digest("hex")}`;
const requestOptions = (record: any) =>
  getConnectedAccountRequestOptions(record.connectedAccountId);
const refundIntentId = (refund: Stripe.Refund) =>
  typeof refund.payment_intent === "string"
    ? refund.payment_intent
    : refund.payment_intent?.id;
const assertRefund = (refund: Stripe.Refund, record: any) => {
  if (
    refundIntentId(refund) !== record.paymentIntentId ||
    refund.amount !== record.cardAmountMinor ||
    refund.currency.toUpperCase() !== record.currency ||
    refund.metadata?.sharioBookingRefundId !== String(record._id) ||
    refund.metadata?.tenantId !== id(record.tenant) ||
    refund.metadata?.orderId !== id(record.order)
  )
    review("Stripe refund does not match the saved booking refund intent.");
};

/** Reconcile a remote outcome before creating it again. The first-attempt clock
 * is persisted BEFORE provider I/O and never reset. After 22 hours an unknown
 * create outcome needs review: Stripe's idempotency retention is not indefinite. */
export async function reconcileBookingCardRefund(
  record: any,
  now = new Date(),
) {
  if (record.failureRecordedAt)
    review("The original refund failed or was canceled and requires review.");
  if (getTenantPaymentStripeLivemode() !== record.livemode)
    review("Stripe mode differs from the original booking payment.");
  const stripe = getTenantPaymentStripe();
  const options = requestOptions(record);
  const intent = await stripe.paymentIntents.retrieve(
    record.paymentIntentId,
    {},
    options,
  );
  if (
    intent.id !== record.paymentIntentId ||
    intent.livemode !== record.livemode ||
    intent.currency.toUpperCase() !== record.currency ||
    intent.status !== "succeeded"
  )
    review("The original card payment cannot be verified.");
  const order = await Order.findOne({
    _id: record.order,
    tenant: record.tenant,
    isPaid: true,
    "stripe.paymentIntentId": record.paymentIntentId,
    "stripe.connectedAccountId": record.connectedAccountId,
  })
    .select("expectedAmountMinor stripe.livemode")
    .lean()
    .exec();
  if (
    !order ||
    order.expectedAmountMinor !== intent.amount_received ||
    order.expectedAmountMinor !== intent.amount ||
    order.stripe.livemode !== record.livemode
  )
    review("The card payment differs from its saved order snapshot.");
  let refund: Stripe.Refund;
  if (record.refundId) {
    refund = await stripe.refunds.retrieve(record.refundId, options);
  } else {
    const refunds = await stripe.refunds.list(
      { payment_intent: record.paymentIntentId, limit: 100 },
      options,
    );
    const matches = refunds.data.filter(
      (row) => row.metadata?.sharioBookingRefundId === String(record._id),
    );
    if (matches.length > 1 || refunds.has_more)
      review("The payment refund history requires reconciliation.");
    if (matches.length === 1) refund = matches[0];
    else {
      // Unrelated dashboard refunds must be allocated by an operator first.
      for (const existing of refunds.data) {
        if (["failed", "canceled"].includes(String(existing.status))) continue;
        const known = await BookingPaymentRefund.findOne({
          _id: existing.metadata?.sharioBookingRefundId ?? "",
          tenant: record.tenant,
          order: record.order,
          cardAmountMinor: existing.amount,
          paymentIntentId: record.paymentIntentId,
        })
          .lean()
          .exec();
        if (!known)
          review(
            "An external payment refund needs allocation before this cancellation refund.",
          );
        assertRefund(existing, known);
      }
      if (
        !record.firstProviderAttemptAt ||
        now.getTime() - new Date(record.firstProviderAttemptAt).getTime() >=
          22 * 60 * 60_000
      )
        review(
          "The refund creation outcome is outside the safe automatic retry window.",
        );
      refund = await stripe.refunds.create(
        {
          payment_intent: record.paymentIntentId,
          amount: record.cardAmountMinor,
          metadata: {
            sharioFlow: "booking-cancellation",
            sharioBookingRefundId: String(record._id),
            tenantId: id(record.tenant),
            orderId: id(record.order),
            bookingId: id(record.booking),
          },
        },
        { ...options, idempotencyKey: refundKey(record) },
      );
    }
  }
  assertRefund(refund, record);
  return {
    refundId: refund.id,
    providerStatus: String(refund.status ?? "pending"),
    status:
      refund.status === "succeeded"
        ? "succeeded"
        : ["failed", "canceled"].includes(String(refund.status))
          ? "review_required"
          : "provider_pending",
  };
}

/** Only the signed Connect webhook dispatcher may supply events. A bank can
 * return a previously successful refund; keep that failure terminal until an
 * operator reconciles it, even if a worker still holds an older success result. */
export async function processBookingPaymentRefundEvent(
  event: Stripe.Event,
): Promise<boolean> {
  if (!["refund.failed", "refund.updated"].includes(String(event.type)))
    return false;
  const accountId = typeof event.account === "string" ? event.account : "";
  const refund = event.data.object as Stripe.Refund;
  if (
    !accountId.startsWith("acct_") ||
    refund.object !== "refund" ||
    !["failed", "canceled"].includes(String(refund.status)) ||
    !refund.id
  )
    return false;
  const paymentIntentId = refundIntentId(refund);
  if (!paymentIntentId) return false;
  const metadataId = String(refund.metadata?.sharioBookingRefundId ?? "");
  const record = await BookingPaymentRefund.findOne({
    connectedAccountId: accountId,
    $or: [
      { refundId: refund.id },
      ...(metadataId
        ? [{ _id: metadataId, refundId: { $in: ["", null] } }]
        : []),
    ],
  })
    .lean()
    .exec();
  if (!record) return false;
  if (
    record.paymentIntentId !== paymentIntentId ||
    record.livemode !== event.livemode ||
    !integer(refund.amount) ||
    refund.amount <= 0 ||
    record.cardAmountMinor !== refund.amount ||
    record.currency !== String(refund.currency).toUpperCase()
  ) {
    throw new Error(
      "Booking refund failure differs from its saved payment snapshot.",
    );
  }
  if (!record.refundId) {
    // The webhook can beat the provider response to our database. Reconcile
    // only an already-attempted intent with all server-created metadata.
    if (!record.firstProviderAttemptAt) return false;
    assertRefund(refund, record);
    if (refund.metadata?.bookingId !== id(record.booking))
      throw new Error("Booking refund failure booking metadata mismatch.");
  } else {
    // Refund metadata is editable in Stripe. Missing metadata is harmless for
    // an exact saved refund ID; contradictory metadata is never reassociated.
    for (const [key, expected] of Object.entries({
      sharioBookingRefundId: String(record._id),
      tenantId: id(record.tenant),
      orderId: id(record.order),
      bookingId: id(record.booking),
    })) {
      if (refund.metadata?.[key] && refund.metadata[key] !== expected)
        throw new Error("Booking refund failure metadata mismatch.");
    }
  }
  const order = await Order.findOne({
    _id: record.order,
    tenant: record.tenant,
    isPaid: true,
    "stripe.connectedAccountId": accountId,
    "stripe.paymentIntentId": paymentIntentId,
    "stripe.livemode": event.livemode,
  })
    .select("currency expectedAmountMinor")
    .lean()
    .exec();
  if (
    !order ||
    order.currency !== record.currency ||
    !integer(order.expectedAmountMinor) ||
    order.expectedAmountMinor < refund.amount
  )
    throw new Error("Booking refund failure has no matching original order.");
  const result = await BookingPaymentRefund.updateOne(
    {
      _id: record._id,
      tenant: record.tenant,
      order: record.order,
      connectedAccountId: accountId,
      paymentIntentId,
      livemode: event.livemode,
      currency: record.currency,
      cardAmountMinor: refund.amount,
      refundId: { $in: ["", null, refund.id] },
    },
    {
      $set: {
        refundId: refund.id,
        providerStatus: String(refund.status),
        status: "review_required",
        failureEventId: event.id,
        failureRecordedAt: new Date(),
        claimToken: "",
        claimExpiresAt: null,
        nextAttemptAt: null,
        completedAt: null,
        lastError:
          "The card refund failed or was canceled. Reconcile the returned payment before issuing another refund.",
      },
    },
  ).exec();
  if (result.matchedCount !== 1)
    throw new Error("Booking refund failure changed during reconciliation.");
  return true;
}

/** Bounded, leased database outbox. Can run on every API replica. */
export async function processBookingPaymentRefunds({
  limit = 20,
  now = new Date(),
}: { limit?: number; now?: Date } = {}) {
  const batchSize = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  let processed = 0;
  for (let index = 0; index < batchSize; index += 1) {
    const claimToken = randomUUID();
    const record = await BookingPaymentRefund.findOneAndUpdate(
      {
        cardAmountMinor: { $gt: 0 },
        failureRecordedAt: null,
        $or: [
          {
            status: { $in: ["pending", "provider_pending"] },
            nextAttemptAt: { $lte: now },
          },
          { status: "processing", claimExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "processing",
          claimToken,
          claimExpiresAt: new Date(now.getTime() + 5 * 60_000),
        },
        $inc: { attempts: 1 },
      },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" },
    )
      .lean()
      .exec();
    if (!record) break;
    const claimed = {
      _id: record._id,
      tenant: record.tenant,
      status: "processing",
      claimToken,
      failureRecordedAt: null,
    };
    try {
      if (!record.firstProviderAttemptAt) {
        const stamped = await BookingPaymentRefund.updateOne(
          { ...claimed, firstProviderAttemptAt: null },
          { $set: { firstProviderAttemptAt: now } },
        ).exec();
        if (stamped.modifiedCount !== 1) continue;
        record.firstProviderAttemptAt = now;
      }
      const outcome = await reconcileBookingCardRefund(record, now);
      await BookingPaymentRefund.updateOne(claimed, {
        $set: {
          ...outcome,
          claimToken: "",
          claimExpiresAt: null,
          lastError: "",
          nextAttemptAt:
            outcome.status === "provider_pending"
              ? new Date(now.getTime() + 15 * 60_000)
              : null,
          completedAt: outcome.status === "succeeded" ? now : null,
        },
      }).exec();
    } catch (error) {
      const needsReview =
        error instanceof RefundReviewRequired ||
        (record.attempts >= 12 && !record.refundId);
      await BookingPaymentRefund.updateOne(claimed, {
        $set: {
          status: needsReview
            ? "review_required"
            : record.refundId
              ? "provider_pending"
              : "pending",
          claimToken: "",
          claimExpiresAt: null,
          nextAttemptAt: needsReview
            ? null
            : new Date(
                now.getTime() +
                  Math.min(60, 2 ** Math.min(record.attempts, 6)) * 60_000,
              ),
          lastError:
            error instanceof RefundReviewRequired
              ? error.message
              : "The payment provider could not confirm the refund. Automatic reconciliation will retry.",
        },
      }).exec();
    }
    processed += 1;
  }
  return { processed };
}
