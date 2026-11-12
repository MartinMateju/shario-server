import mongoose from "mongoose";
import type Stripe from "stripe";
import { Coupon, CouponOrder } from "./coupon.model.js";
import {
  hasVoucherBeenUsed,
  revokeVoucherInSession,
} from "./voucher-lifecycle.service.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { findTenantPaymentAccountByStripeAccount } from "@/modules/tenant-payments/tenant-payment-account.repository.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import {
  VoucherManagementRefund,
  voucherManagementRefundId,
  VOUCHER_REFUND_PENDING_REASON,
} from "./voucher-management-refund.model.js";
import {
  normalizeCouponCurrency,
  couponAmountToMinorUnits,
} from "./coupon.utils.js";

const expectedPurchaseAmount = (order: {
  expectedAmountMinor?: number;
  totalSnapshot: number;
  currencySnapshot: string;
}) =>
  order.expectedAmountMinor ||
  couponAmountToMinorUnits(
    order.totalSnapshot,
    normalizeCouponCurrency(order.currencySnapshot),
  );

export const voucherRefundDisposition = (input: {
  expectedAmountMinor: number;
  amountRefundedMinor: number;
  previousRefundedMinor?: number;
}) => {
  for (const value of [
    input.expectedAmountMinor,
    input.amountRefundedMinor,
    input.previousRefundedMinor ?? 0,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid voucher refund amounts.");
  }
  if (
    input.expectedAmountMinor <= 0 ||
    input.amountRefundedMinor > input.expectedAmountMinor
  )
    throw new Error("Voucher refund exceeds the purchased amount.");
  if (input.amountRefundedMinor <= (input.previousRefundedMinor ?? 0))
    return "replay" as const;
  return input.amountRefundedMinor === input.expectedAmountMinor
    ? ("full" as const)
    : ("partial" as const);
};

/** Only verified Connect webhook events reach this function. The function never
 * initiates a Stripe refund; it reconciles refunds made through existing tools. */
export const processVoucherRefundEvent = async (
  event: Stripe.Event,
): Promise<boolean> => {
  const refundUpdate = ["refund.failed", "refund.updated"].includes(
    String(event.type),
  );
  if (event.type !== "charge.refunded" && !refundUpdate) return false;
  const accountId = typeof event.account === "string" ? event.account : "";
  if (!accountId) return false;
  const refund = refundUpdate ? (event.data.object as Stripe.Refund) : null;
  if (
    refund &&
    (refund.object !== "refund" ||
      !["failed", "canceled"].includes(String(refund.status)))
  )
    return false;
  const refundChargeId =
    typeof refund?.charge === "string" ? refund.charge : refund?.charge?.id;
  if (refund && !refundChargeId) return false;
  const charge = refund
    ? await getTenantPaymentStripe().charges.retrieve(
        refundChargeId!,
        {},
        getConnectedAccountRequestOptions(accountId),
      )
    : (event.data.object as Stripe.Charge);
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!accountId || !paymentIntentId || charge.object !== "charge")
    return false;
  const account = await findTenantPaymentAccountByStripeAccount(accountId);
  if (!account) return false;
  if (charge.livemode !== event.livemode)
    throw new Error("Voucher refund livemode mismatch.");
  if (refund) {
    const refundIntentId =
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : refund.payment_intent?.id;
    if (
      charge.id !== refundChargeId ||
      (refundIntentId && refundIntentId !== paymentIntentId) ||
      refund.currency.toUpperCase() !== charge.currency.toUpperCase() ||
      !Number.isSafeInteger(refund.amount) ||
      refund.amount <= 0 ||
      refund.amount > charge.amount
    )
      throw new Error("Voucher refund failure does not match its charge.");
  }
  const tenantId = String(account.tenant);
  let order = await CouponOrder.findOne({
    tenant: tenantId,
    stripeConnectedAccountId: accountId,
    stripePaymentIntentId: paymentIntentId,
  })
    .lean()
    .exec();
  if (!order) {
    // Refund delivery may precede the checkout-completed webhook. New Checkout
    // sessions place a server-controlled order reference on the PaymentIntent.
    const intent = await getTenantPaymentStripe().paymentIntents.retrieve(
      paymentIntentId,
      {},
      getConnectedAccountRequestOptions(accountId),
    );
    if (
      intent.metadata?.sharioManaged !== "true" ||
      intent.metadata?.sharioFlow !== "voucher-purchase"
    )
      return false;
    if (
      intent.metadata.tenantId !== tenantId ||
      !mongoose.isValidObjectId(intent.metadata.couponOrderId)
    )
      throw new Error("Voucher refund tenant metadata mismatch.");
    order = await CouponOrder.findOne({
      _id: intent.metadata.couponOrderId,
      tenant: tenantId,
      stripeConnectedAccountId: accountId,
    })
      .lean()
      .exec();
    if (!order)
      throw new Error("Refunded voucher purchase has no matching order.");
    if (
      order.stripePaymentIntentId &&
      order.stripePaymentIntentId !== paymentIntentId
    )
      throw new Error("Voucher refund PaymentIntent mismatch.");
    if (
      intent.livemode !== event.livemode ||
      intent.currency.toUpperCase() !== order.currencySnapshot ||
      intent.amount !== expectedPurchaseAmount(order)
    )
      throw new Error("Voucher refund purchase snapshot mismatch.");
    // Metadata is mutable in the connected account dashboard. Prove the payment
    // belongs to our saved Checkout Session before associating it with this order.
    if (!order.stripeSessionId)
      throw new Error("Voucher refund order has no saved Checkout Session.");
    const checkout = await getTenantPaymentStripe().checkout.sessions.retrieve(
      order.stripeSessionId,
      {},
      getConnectedAccountRequestOptions(accountId),
    );
    const checkoutIntentId =
      typeof checkout.payment_intent === "string"
        ? checkout.payment_intent
        : checkout.payment_intent?.id;
    if (
      checkout.id !== order.stripeSessionId ||
      checkoutIntentId !== paymentIntentId ||
      checkout.livemode !== event.livemode ||
      checkout.currency?.toUpperCase() !== order.currencySnapshot ||
      checkout.amount_total !== expectedPurchaseAmount(order)
    ) {
      throw new Error(
        "Voucher refund does not belong to the stored Checkout Session.",
      );
    }
  }
  await reconcileVerifiedVoucherRefundCharge({
    tenantId,
    orderId: String(order._id),
    accountId,
    paymentIntentId,
    charge,
    eventId: event.id,
    livemode: event.livemode,
    refund,
  });
  return true;
};

/** Internal reconciliation boundary. Callers must first obtain the charge from a
 * verified Connect event or an authenticated Stripe API response on the stored
 * connected account. This function never initiates a refund. */
export const reconcileVerifiedVoucherRefundCharge = async ({
  tenantId,
  orderId,
  accountId,
  paymentIntentId,
  charge,
  eventId,
  livemode,
  refund = null,
}: {
  tenantId: string;
  orderId: string;
  accountId: string;
  paymentIntentId: string;
  charge: Stripe.Charge;
  eventId: string;
  livemode: boolean;
  refund?: Stripe.Refund | null;
}): Promise<void> => {
  const chargeIntent =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (
    charge.object !== "charge" ||
    chargeIntent !== paymentIntentId ||
    charge.livemode !== livemode
  ) {
    throw new Error("Voucher refund charge identity mismatch.");
  }
  await mongoose.connection.transaction(async (session) => {
    await acquireVoucherTenantMutationLock(tenantId, session);
    const current = await CouponOrder.findOne({
      _id: orderId,
      tenant: tenantId,
      stripeConnectedAccountId: accountId,
    })
      .session(session)
      .exec();
    if (!current) throw new Error("Voucher refund order disappeared.");
    const expectedAmountMinor = expectedPurchaseAmount(current);
    if (
      current.stripeLivemode !== livemode ||
      charge.currency.toUpperCase() !== current.currencySnapshot ||
      charge.amount !== expectedAmountMinor ||
      (current.stripePaymentIntentId &&
        current.stripePaymentIntentId !== paymentIntentId)
    ) {
      throw new Error(
        "Voucher refund does not match the stored payment snapshot.",
      );
    }
    if (current.processedRefundEventIds.includes(eventId)) return;
    if (refund) {
      current.processedRefundEventIds.push(eventId);
      current.stripePaymentIntentId = paymentIntentId;
      current.refundFailureReviewRequired = true;
      current.refundState = "manual_review";
      current.refundReviewReason =
        "Refund failed or was canceled: reconcile the returned payment before restoring any voucher entitlement.";
      const coupons = await Coupon.find({
        tenant: tenantId,
        order: current._id,
      })
        .session(session)
        .exec();
      for (const coupon of coupons) {
        coupon.refundReviewRequired = true;
        await coupon.save({ session });
      }
      await VoucherManagementRefund.updateOne(
        {
          _id: voucherManagementRefundId(tenantId, orderId),
          tenant: tenantId,
          couponOrder: current._id,
          accountId,
          paymentIntentId,
          stripeRefundId: refund.id,
        },
        {
          $set: {
            status: "review_required",
            reviewReason: current.refundReviewReason,
            nextAttemptAt: null,
            claimToken: "",
            claimExpiresAt: null,
          },
        },
        { session },
      ).exec();
      // The order hold and claim invalidation commit together. A worker holding
      // an earlier provider-success response can no longer complete this intent.
      await current.save({ session });
      return;
    }
    const disposition = voucherRefundDisposition({
      expectedAmountMinor,
      amountRefundedMinor: charge.amount_refunded,
      previousRefundedMinor: current.refundedAmountMinor,
    });
    current.processedRefundEventIds.push(eventId);
    current.stripePaymentIntentId = paymentIntentId;
    if (disposition === "replay") {
      await current.save({ session });
      return;
    }
    const ownRefundHold =
      disposition === "full" &&
      !current.refundFailureReviewRequired &&
      current.refundedAmountMinor === 0 &&
      current.refundReviewReason === VOUCHER_REFUND_PENDING_REASON &&
      Boolean(
        await VoucherManagementRefund.exists({
          _id: voucherManagementRefundId(tenantId, orderId),
          tenant: tenantId,
          couponOrder: current._id,
          accountId,
          paymentIntentId,
          amountMinor: expectedAmountMinor,
          status: { $in: ["pending", "submitting"] },
        })
          .session(session)
          .exec(),
      );
    const completedPartialRefund =
      disposition === "full" &&
      !current.refundFailureReviewRequired &&
      current.refundedAmountMinor > 0 &&
      current.refundedAmountMinor < expectedAmountMinor &&
      current.refundReviewReason ===
        "Partial purchase refund: select the affected voucher liability before reactivating codes.";
    const clearRefundHold = ownRefundHold || completedPartialRefund;
    current.refundedAmountMinor = charge.amount_refunded;
    const coupons = await Coupon.find({ tenant: tenantId, order: current._id })
      .session(session)
      .exec();
    let needsReview =
      disposition === "partial" || current.refundFailureReviewRequired;
    for (const coupon of coupons) {
      if (coupon.revokedAt) continue;
      const held = Boolean(
        coupon.reservedAt ||
        coupon.reservedOrder ||
        coupon.reservedBy ||
        coupon.reservedUntil ||
        coupon.reservedValueMinor > 0 ||
        coupon.reservedQuantity > 0,
      );
      if (
        disposition === "partial" ||
        current.refundFailureReviewRequired ||
        (coupon.refundReviewRequired && !clearRefundHold) ||
        hasVoucherBeenUsed(coupon) ||
        held
      ) {
        needsReview = true;
        coupon.refundReviewRequired = true;
        await coupon.save({ session });
        continue;
      }
      if (clearRefundHold && coupon.refundReviewRequired) {
        coupon.refundReviewRequired = false;
        await coupon.save({ session });
      }
      if (coupon.isActive) {
        await revokeVoucherInSession(
          {
            tenantId,
            couponId: coupon._id,
            operationId: `refund:${paymentIntentId}:${coupon._id}`,
            reason: "Voucher purchase fully refunded through Stripe",
          },
          session,
        );
      }
    }
    current.refundState = needsReview ? "manual_review" : "revoked";
    current.refundReviewReason = current.refundFailureReviewRequired
      ? "Refund failed or was canceled: reconcile the returned payment before restoring any voucher entitlement."
      : needsReview
        ? disposition === "partial"
          ? "Partial purchase refund: select the affected voucher liability before reactivating codes."
          : "Refunded purchase contains used or payment-reserved vouchers; reconcile without removing customer account credits."
        : "";
    await current.save({ session });
  });
};
