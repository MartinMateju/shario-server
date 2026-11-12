import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import type Stripe from "stripe";
import { logger } from "@/config/logger.js";
import { AppError } from "@/shared/http/AppError.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { findTenantPaymentAccountByStripeAccount } from "@/modules/tenant-payments/tenant-payment-account.repository.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
  getTenantPaymentStripeLivemode,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { Coupon, CouponOrder } from "./coupon.model.js";
import {
  VoucherManagementRefund,
  voucherManagementRefundId,
  VOUCHER_REFUND_PENDING_REASON,
} from "./voucher-management-refund.model.js";
import {
  expectedVoucherPurchaseAmount,
  purchaseRefundBlocker,
} from "./voucher-management-policy.js";
import { reconcileVerifiedVoucherRefundCharge } from "./voucher-refund.service.js";

const CLAIM_MS = 5 * 60_000;
// Stripe retains an idempotency key for at least 24 hours. Stop creation earlier;
// recovery after this window only retrieves an existing provider refund.
const CREATE_WINDOW_MS = 23 * 60 * 60_000;
const MAX_ATTEMPTS = 8;
const fail = (code: string, message: string, statusCode = 409): never => {
  throw new AppError({ code, message, statusCode });
};
const validId = (id: string) => /^[a-f\d]{24}$/i.test(id);
const paymentIntentIdOf = (
  value: string | { id: string } | null | undefined,
) => (typeof value === "string" ? value : value?.id);
const dto = (intent: any) =>
  intent
    ? {
        id: String(intent._id),
        status: intent.status,
        reason: intent.reason,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      }
    : null;

export const getVoucherManagementRefund = async (
  tenantId: string,
  orderId: string,
) =>
  dto(
    await VoucherManagementRefund.findOne({
      _id: voucherManagementRefundId(tenantId, orderId),
      tenant: tenantId,
      couponOrder: orderId,
    })
      .lean()
      .exec(),
  );

export async function requestVoucherPurchaseRefund(input: {
  tenantId: string;
  couponOrderId: string;
  actorId: string;
  operationId: string;
  reason: string;
}) {
  if (
    ![input.tenantId, input.couponOrderId, input.actorId].every(validId) ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
      input.operationId,
    ) ||
    !input.reason?.trim() ||
    input.reason.trim().length > 1000
  ) {
    fail(
      "VOUCHER_REFUND_INPUT_INVALID",
      "Provide valid voucher purchase identifiers and a refund reason.",
      400,
    );
  }
  const id = voucherManagementRefundId(input.tenantId, input.couponOrderId);
  await mongoose.connection.transaction(async (session) => {
    await acquireVoucherTenantMutationLock(input.tenantId, session);
    const order = await CouponOrder.findOne({
      _id: input.couponOrderId,
      tenant: input.tenantId,
    })
      .session(session)
      .exec();
    if (!order)
      fail("VOUCHER_ORDER_NOT_FOUND", "Voucher order not found.", 404);
    // All requests for the same purchase use the original durable intent, even
    // if another administrator clicks with a new client operation id.
    if (
      await VoucherManagementRefund.exists({
        _id: id,
        tenant: input.tenantId,
        couponOrder: order._id,
      })
        .session(session)
        .exec()
    )
      return;
    const coupons = await Coupon.find({
      tenant: input.tenantId,
      order: order._id,
    })
      .session(session)
      .exec();
    const blocker = purchaseRefundBlocker(order, coupons);
    if (blocker)
      fail(
        `VOUCHER_REFUND_${blocker.toUpperCase()}`,
        "This purchase cannot be automatically refunded. Review its voucher usage and payment history.",
      );
    await VoucherManagementRefund.create(
      [
        {
          _id: id,
          tenant: input.tenantId,
          couponOrder: order._id,
          operationId: input.operationId,
          actor: input.actorId,
          reason: input.reason.trim(),
          accountId: order.stripeConnectedAccountId,
          paymentIntentId: order.stripePaymentIntentId,
          amountMinor: expectedVoucherPurchaseAmount(order),
          currency: order.currencySnapshot,
          livemode: order.stripeLivemode,
        },
      ],
      { session },
    );
    // This write is in the same tenant-serialized transaction as eligibility.
    // Every voucher debit path checks this existing refund hold field.
    for (const coupon of coupons) {
      coupon.refundReviewRequired = true;
      await coupon.save({ session });
    }
    order.refundState = "manual_review";
    order.refundReviewReason = VOUCHER_REFUND_PENDING_REASON;
    await order.save({ session });
  });
  return getVoucherManagementRefund(input.tenantId, input.couponOrderId);
}

const markReview = async (intent: any, reason: string) => {
  await mongoose.connection.transaction(async (session) => {
    const changed = await VoucherManagementRefund.updateOne(
      { _id: intent._id, claimToken: intent.claimToken, status: "submitting" },
      {
        $set: {
          status: "review_required",
          reviewReason: reason,
          nextAttemptAt: null,
          claimToken: "",
          claimExpiresAt: null,
        },
      },
      { session },
    ).exec();
    if (!changed.modifiedCount) return;
    await CouponOrder.updateOne(
      {
        _id: intent.couponOrder,
        tenant: intent.tenant,
        refundState: { $ne: "revoked" },
      },
      {
        $set: { refundState: "manual_review", refundReviewReason: reason },
      },
      { session },
    ).exec();
  });
};

const assertCharge = (intent: any, charge: Stripe.Charge) => {
  if (
    charge.object !== "charge" ||
    !charge.paid ||
    charge.livemode !== intent.livemode ||
    charge.currency.toUpperCase() !== intent.currency ||
    charge.amount !== intent.amountMinor ||
    paymentIntentIdOf(charge.payment_intent) !== intent.paymentIntentId
  ) {
    fail(
      "VOUCHER_REFUND_PAYMENT_MISMATCH",
      "The stored purchase does not match the payment provider.",
    );
  }
};
const assertRefund = (intent: any, refund: Stripe.Refund) => {
  if (
    refund.object !== "refund" ||
    refund.currency.toUpperCase() !== intent.currency ||
    refund.amount !== intent.amountMinor ||
    paymentIntentIdOf(refund.payment_intent) !== intent.paymentIntentId ||
    refund.metadata?.sharioVoucherRefundId !== intent._id
  ) {
    fail(
      "VOUCHER_REFUND_PROVIDER_MISMATCH",
      "The provider refund does not match the saved request.",
    );
  }
};

async function processClaim(intent: any) {
  const stripe = getTenantPaymentStripe();
  const options = getConnectedAccountRequestOptions(intent.accountId);
  const account = await findTenantPaymentAccountByStripeAccount(
    intent.accountId,
  );
  if (
    !account ||
    String(account.tenant) !== String(intent.tenant) ||
    getTenantPaymentStripeLivemode() !== intent.livemode
  ) {
    return markReview(
      intent,
      "The original payment account or mode requires review before refunding.",
    );
  }
  const payment = await stripe.paymentIntents.retrieve(
    intent.paymentIntentId,
    { expand: ["latest_charge"] },
    options,
  );
  if (
    payment.status !== "succeeded" ||
    payment.livemode !== intent.livemode ||
    payment.amount !== intent.amountMinor ||
    payment.currency.toUpperCase() !== intent.currency
  ) {
    return markReview(
      intent,
      "The purchase payment no longer matches its saved paid snapshot.",
    );
  }
  const chargeId = paymentIntentIdOf(payment.latest_charge);
  if (!chargeId)
    return markReview(
      intent,
      "The original paid charge could not be verified.",
    );
  let charge =
    typeof payment.latest_charge === "object" && payment.latest_charge
      ? (payment.latest_charge as Stripe.Charge)
      : await stripe.charges.retrieve(chargeId, {}, options);
  assertCharge(intent, charge);
  let refund: Stripe.Refund | undefined;
  if (intent.stripeRefundId) {
    refund = await stripe.refunds.retrieve(intent.stripeRefundId, {}, options);
  } else {
    const refunds = await stripe.refunds.list(
      { payment_intent: intent.paymentIntentId, limit: 100 },
      options,
    );
    refund = refunds.data.find(
      (row) => row.metadata?.sharioVoucherRefundId === intent._id,
    );
    if (
      refunds.has_more ||
      refunds.data.some(
        (row) =>
          row.id !== refund?.id &&
          !["failed", "canceled"].includes(String(row.status)),
      ) ||
      (charge.amount_refunded > 0 && !refund)
    ) {
      return markReview(
        intent,
        "Another refund already exists for this purchase. Reconcile it before taking further action.",
      );
    }
    if (!refund) {
      if (
        intent.firstProviderAttemptAt &&
        Date.now() - new Date(intent.firstProviderAttemptAt).getTime() >=
          CREATE_WINDOW_MS
      ) {
        return markReview(
          intent,
          "The safe retry window expired without a confirmed refund. Check the payment provider; no additional refund was initiated.",
        );
      }
      const now = new Date();
      const fenced = await VoucherManagementRefund.updateOne(
        {
          _id: intent._id,
          claimToken: intent.claimToken,
          status: "submitting",
          claimExpiresAt: { $gt: now },
        },
        {
          $set: {
            firstProviderAttemptAt: intent.firstProviderAttemptAt || now,
          },
        },
      ).exec();
      if (!fenced.matchedCount) return;
      refund = await stripe.refunds.create(
        {
          payment_intent: intent.paymentIntentId,
          amount: intent.amountMinor,
          metadata: {
            sharioVoucherRefundId: intent._id,
            tenantId: String(intent.tenant),
            couponOrderId: String(intent.couponOrder),
          },
        },
        getConnectedAccountRequestOptions(intent.accountId, {
          idempotencyKey: intent._id,
        }),
      );
    }
  }
  assertRefund(intent, refund);
  const recorded = await VoucherManagementRefund.updateOne(
    { _id: intent._id, claimToken: intent.claimToken, status: "submitting" },
    { $set: { stripeRefundId: refund.id } },
  ).exec();
  if (!recorded.matchedCount) return;
  if (["failed", "canceled"].includes(String(refund.status))) {
    return markReview(
      intent,
      "The payment provider reports that the refund failed or was canceled. Review the payment before restoring vouchers.",
    );
  }
  if (refund.status !== "succeeded") {
    await VoucherManagementRefund.updateOne(
      { _id: intent._id, claimToken: intent.claimToken, status: "submitting" },
      {
        $set: {
          status: "pending",
          nextAttemptAt: new Date(Date.now() + 5 * 60_000),
          claimToken: "",
          claimExpiresAt: null,
        },
      },
    ).exec();
    return;
  }
  charge = await stripe.charges.retrieve(chargeId, {}, options);
  assertCharge(intent, charge);
  if (charge.amount_refunded !== intent.amountMinor)
    return markReview(
      intent,
      "The successful refund total requires payment reconciliation.",
    );
  await reconcileVerifiedVoucherRefundCharge({
    tenantId: String(intent.tenant),
    orderId: String(intent.couponOrder),
    accountId: intent.accountId,
    paymentIntentId: intent.paymentIntentId,
    charge,
    eventId: `management-refund:${refund.id}`,
    livemode: intent.livemode,
  });
  await mongoose.connection.transaction(async (session) => {
    await acquireVoucherTenantMutationLock(String(intent.tenant), session);
    const order = await CouponOrder.findOne({
      _id: intent.couponOrder,
      tenant: intent.tenant,
    })
      .session(session)
      .exec();
    if (
      !order ||
      order.refundState !== "revoked" ||
      order.refundedAmountMinor !== intent.amountMinor
    ) {
      // The payment succeeded but an independent webhook found a reconciliation
      // issue. Never represent the liability as safely settled in this case.
      await VoucherManagementRefund.updateOne(
        { _id: intent._id, claimToken: intent.claimToken },
        {
          $set: {
            status: "review_required",
            reviewReason:
              "Payment refunded; voucher reconciliation still requires review.",
            nextAttemptAt: null,
            claimToken: "",
            claimExpiresAt: null,
          },
        },
        { session },
      ).exec();
      return;
    }
    const changed = await VoucherManagementRefund.updateOne(
      { _id: intent._id, claimToken: intent.claimToken, status: "submitting" },
      {
        $set: {
          status: "succeeded",
          nextAttemptAt: null,
          claimToken: "",
          claimExpiresAt: null,
        },
      },
      { session },
    ).exec();
    if (changed.modifiedCount)
      await Coupon.updateMany(
        {
          tenant: intent.tenant,
          order: intent.couponOrder,
          revokedAt: { $ne: null },
        },
        { $set: { refundReviewRequired: false } },
        { session },
      ).exec();
  });
}

/** Bounded durable worker, safe across server processes and webhook races. */
export async function processVoucherManagementRefunds({
  limit = 10,
}: { limit?: number } = {}) {
  const cap = Math.min(50, Math.max(1, Math.floor(limit)));
  let processed = 0;
  for (; processed < cap; processed++) {
    const now = new Date();
    const intent = await VoucherManagementRefund.findOneAndUpdate(
      {
        $or: [
          { status: "pending", nextAttemptAt: { $lte: now } },
          { status: "submitting", claimExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "submitting",
          claimToken: randomUUID(),
          claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after", sort: { nextAttemptAt: 1, createdAt: 1 } },
    )
      .lean()
      .exec();
    if (!intent) break;
    try {
      // Existing provider refunds can remain pending for days. Retrieval of a
      // known provider id remains safe beyond the creation retry budget.
      if (intent.attempts > MAX_ATTEMPTS && !intent.stripeRefundId) {
        await markReview(
          intent,
          "Automatic refund attempts are exhausted. Verify the original payment before taking further action.",
        );
      } else await processClaim(intent);
    } catch (error) {
      if (error instanceof AppError || intent.attempts >= MAX_ATTEMPTS) {
        await markReview(
          intent,
          "The refund outcome needs review. Verify the original payment; voucher value remains held.",
        );
      } else {
        await VoucherManagementRefund.updateOne(
          {
            _id: intent._id,
            claimToken: intent.claimToken,
            status: "submitting",
          },
          {
            $set: {
              status: "pending",
              nextAttemptAt: new Date(
                Date.now() + Math.min(60, 2 ** intent.attempts) * 60_000,
              ),
              claimToken: "",
              claimExpiresAt: null,
            },
          },
        ).exec();
      }
      logger.warn(
        {
          refundIntentId: intent._id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Voucher purchase refund attempt deferred",
      );
    }
  }
  return { processed };
}
