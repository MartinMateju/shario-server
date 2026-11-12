import mongoose from "mongoose";
import Order from "@/modules/order/order.model.js";
import { checkoutRepository } from "../checkout.repository.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { VoucherLifecycleError } from "@/modules/coupon/voucher-lifecycle.service.js";
import type Stripe from "stripe";
import { deriveGuestAccessToken, verifyGuestCheckoutAccess } from "../checkout.guest-access.js";

/** Keep the replayable Stripe request without persisting a guest's bearer. */
export function snapshotVoucherStripeRequest(
  request: Stripe.Checkout.SessionCreateParams,
  guestCheckout: boolean,
): Stripe.Checkout.SessionCreateParams {
  if (!guestCheckout) return request;
  const stripProof = (value: string | undefined) => {
    if (!value) return value;
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  };
  return { ...request, success_url: stripProof(request.success_url), cancel_url: stripProof(request.cancel_url) };
}

async function restoreVoucherStripeRequest(tenantId: string, order: any) {
  if (order.guestCourseCheckout?.version !== 1) return order.voucherStripeRequest;
  const stored = await Order.findOne({ _id: order._id, tenant: tenantId, "guestCourseCheckout.version": 1 })
    .select("+guestCourseCheckout.accessNonce +guestCourseCheckout.accessTokenHash +guestCourseCheckout.accessExpiresAt")
    .lean().exec();
  if (!stored?.guestCourseCheckout?.accessNonce) throw new VoucherLifecycleError(
    "VOUCHER_PAYMENT_REVIEW_REQUIRED", "This voucher payment needs review before retrying.",
  );
  const accessToken = deriveGuestAccessToken(tenantId, String(order._id), stored.guestCourseCheckout.accessNonce);
  if (!verifyGuestCheckoutAccess(accessToken, stored.guestCourseCheckout)) throw new VoucherLifecycleError(
    "VOUCHER_PAYMENT_REVIEW_REQUIRED", "This voucher payment needs review before retrying.",
  );
  const withProof = (value: string) => {
    const url = new URL(value);
    url.hash = new URLSearchParams({ access_token: accessToken }).toString();
    return url.toString();
  };
  return { ...order.voucherStripeRequest,
    success_url: withProof(order.voucherStripeRequest.success_url),
    cancel_url: withProof(order.voucherStripeRequest.cancel_url),
  };
}

/** Persisted requests make an interrupted create retryable without double spend. */
export async function recoverVoucherStripeSession(
  tenantId: string,
  order: any,
) {
  const stripe = getTenantPaymentStripe();
  const accountId = String(order.stripe?.connectedAccountId || "");
  const options = getConnectedAccountRequestOptions(accountId);
  const attached = String(order.stripe?.sessionId || "");
  let session: Stripe.Checkout.Session;
  if (attached)
    session = await stripe.checkout.sessions.retrieve(attached, options);
  else {
    const age = Date.now() - new Date(order.createdAt).getTime();
    if (
      !order.voucherStripeRequest ||
      !Number.isFinite(age) ||
      age >= 23 * 60 * 60 * 1000
    )
      throw new VoucherLifecycleError(
        "VOUCHER_PAYMENT_REVIEW_REQUIRED",
        "This voucher payment needs review before retrying.",
      );
    const created = await stripe.checkout.sessions.create(
      await restoreVoucherStripeRequest(tenantId, order),
      { ...options, idempotencyKey: `checkout-session:${String(order._id)}` },
    );
    // Stripe may return the original idempotency response. Retrieve its current
    // state before deciding whether the held value can be released.
    session = await stripe.checkout.sessions.retrieve(created.id, options);
  }
  if (
    session.client_reference_id !== String(order._id) ||
    session.metadata?.tenantId !== tenantId ||
    session.currency?.toUpperCase() !== order.currency ||
    session.amount_total !== order.expectedAmountMinor ||
    (order.stripe?.livemode !== null &&
      order.stripe?.livemode !== undefined &&
      order.stripe.livemode !== session.livemode)
  )
    throw new Error(
      "Recovered voucher payment does not match the saved order.",
    );
  if (!attached) {
    const result = await checkoutRepository.attachStripeSession({
      tenantId,
      orderId: order._id,
      sessionId: session.id,
      amountMinor: order.expectedAmountMinor,
      currency: order.currency,
      connectedAccountId: accountId,
      livemode: session.livemode,
    });
    if (result.modifiedCount !== 1)
      throw new Error("Recovered voucher session could not be attached.");
  }
  return session;
}

export async function cancelVoucherCheckout({
  tenantId,
  userId,
  orderId,
}: {
  tenantId: string;
  userId: string;
  orderId: string;
}) {
  if (!mongoose.isValidObjectId(orderId))
    throw new VoucherLifecycleError(
      "VOUCHER_ORDER_NOT_FOUND",
      "Payment order not found.",
      404,
    );
  const order = await Order.findOne({
    _id: orderId,
    tenant: tenantId,
    createdBy: userId,
    "voucherRedemptions.0": { $exists: true },
  })
    .select("+voucherStripeRequest")
    .lean()
    .exec();
  if (!order)
    throw new VoucherLifecycleError(
      "VOUCHER_ORDER_NOT_FOUND",
      "Payment order not found.",
      404,
    );
  if (order.voucherCheckoutReleasedAt)
    return { orderId, status: "cancelled_order", voucherReleased: true };
  if (order.isPaid || !order.expectedAmountMinor)
    throw new VoucherLifecycleError(
      "VOUCHER_PAYMENT_CONFIRMED",
      "Payment is confirmed; cancel the booking instead.",
    );
  let session = await recoverVoucherStripeSession(tenantId, order);
  if (session.status === "open")
    session = await getTenantPaymentStripe().checkout.sessions.expire(
      session.id,
      getConnectedAccountRequestOptions(order.stripe.connectedAccountId),
    );
  if (session.status !== "expired" || session.payment_status === "paid")
    throw new VoucherLifecycleError(
      "VOUCHER_PAYMENT_PENDING",
      "Payment may be completing. Check the order status.",
    );
  const released = await checkoutRepository.releaseExpiredStripeOrder({
    tenantId,
    orderId,
    sessionId: session.id,
    connectedAccountId: order.stripe.connectedAccountId,
  });
  if (!released)
    throw new VoucherLifecycleError(
      "VOUCHER_PAYMENT_PENDING",
      "Payment may be completing. Check the order status.",
    );
  return { orderId, status: "cancelled_order", voucherReleased: true };
}

/** Recover interrupted creation and missed expiration webhooks. Never infer
 * non-payment from elapsed time or a browser redirect. Stripe must confirm it. */
export async function reconcileVoucherCheckoutSessions({
  limit = 25,
}: { limit?: number } = {}) {
  const orders = await Order.find({
    isPaid: false,
    voucherCheckoutReleasedAt: null,
    "voucherRedemptions.0": { $exists: true },
    status: { $in: ["pending_order", "cancelled_order"] },
    $or: [
      {
        "stripe.sessionId": "",
        createdAt: { $gte: new Date(Date.now() - 23 * 60 * 60 * 1000) },
      },
      {
        "stripe.sessionId": { $ne: "" },
        "voucherStripeRequest.expires_at": {
          $lte: Math.floor(Date.now() / 1000),
        },
      },
    ],
  })
    .select("+voucherStripeRequest")
    .sort({ updatedAt: 1 })
    .limit(Math.min(100, Math.max(1, limit)))
    .lean()
    .exec();
  let released = 0;
  for (const order of orders) {
    try {
      const session = await recoverVoucherStripeSession(
        String(order.tenant),
        order,
      );
      if (session.status === "expired" && session.payment_status !== "paid") {
        if (
          await checkoutRepository.releaseExpiredStripeOrder({
            tenantId: order.tenant,
            orderId: order._id,
            sessionId: session.id,
            connectedAccountId: order.stripe.connectedAccountId,
          })
        )
          released++;
      }
    } catch (error) {
      console.error(
        "[VOUCHER_CHECKOUT_RECONCILIATION]",
        String(order._id),
        error instanceof Error ? error.message : "Failed",
      );
    } finally {
      await Order.updateOne(
        { _id: order._id, tenant: order.tenant },
        { $set: { updatedAt: new Date() } },
      ).exec();
    }
  }
  return { checked: orders.length, released };
}
