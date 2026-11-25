import mongoose from "mongoose";
import type Stripe from "stripe";

import Order from "@/modules/order/order.model.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import { assertStripeCheckoutSessionIdentity } from "../checkout.card-recovery.js";
import { isCancellableOpenStudioCardOrder } from "../checkout.cancellation-policy.js";
import { checkoutRepository } from "../checkout.repository.js";

const paymentPending = (): never => conflict({
  code: "CHECKOUT_PAYMENT_PENDING",
  message: "The payment cannot be safely cancelled yet. Check its status before trying again.",
});

const paymentConfirmed = (): never => conflict({
  code: "CHECKOUT_PAYMENT_CONFIRMED",
  message: "This checkout is already paid. Check your reservation instead of paying again.",
});

export const cancelOpenStudioCardCheckout = async ({
  tenantId,
  userId,
  orderId,
}: {
  tenantId: string;
  userId: string;
  orderId: string;
}) => {
  if (!mongoose.isValidObjectId(orderId)) notFound({
    code: "CHECKOUT_ORDER_NOT_FOUND", message: "Payment order not found.",
  });
  const order = await Order.findOne({
    _id: orderId, tenant: tenantId, createdBy: userId,
  }).lean().exec();
  if (!order) notFound({
    code: "CHECKOUT_ORDER_NOT_FOUND", message: "Payment order not found.",
  });
  if (order.isPaid) paymentConfirmed();
  if (order.stripe?.paymentIntentId || order.stripe?.processingClaimToken) paymentPending();
  if (!isCancellableOpenStudioCardOrder(order)) conflict({
    code: "CHECKOUT_CANCELLATION_UNSUPPORTED",
    message: "This checkout cannot be cancelled through the Open Studio payment flow.",
  });

  const stripe = getTenantPaymentStripe();
  const sessionId = order.stripe!.sessionId!;
  const accountId = order.stripe!.connectedAccountId!;
  const options = getConnectedAccountRequestOptions(accountId);
  const verifySession = (session: Stripe.Checkout.Session) => {
    try {
      if (session.id !== sessionId) paymentPending();
      assertStripeCheckoutSessionIdentity(session, {
        tenantId, orderId, connectedAccountId: accountId,
        currency: String(order.currency).toLowerCase(),
        expectedAmountMinor: order.expectedAmountMinor!,
        livemode: order.stripe!.livemode!,
      });
    } catch {
      paymentPending();
    }
    if (session.payment_status === "paid") paymentConfirmed();
    if (session.payment_status !== "unpaid" || session.payment_intent) paymentPending();
  };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, options);
  } catch {
    // A timeout is not evidence that the customer has not paid.
    paymentPending();
  }
  verifySession(session);
  if (session.status === "open") {
    try {
      session = await stripe.checkout.sessions.expire(sessionId, options);
    } catch {
      // Payment may have completed between retrieval and expiration.
      paymentPending();
    }
    verifySession(session);
  }
  if (session.status !== "expired") paymentPending();

  // Rechecks payment/processing state atomically before releasing capacity.
  // Also finishes partial cleanup when expiry or another request won the race.
  const released = await checkoutRepository.releaseExpiredStripeOrder({
    tenantId, orderId, sessionId, connectedAccountId: accountId,
  });
  if (!released) {
    const current = await Order.findOne({
      _id: orderId, tenant: tenantId, createdBy: userId,
    }).select("isPaid").lean().exec();
    if (current?.isPaid) paymentConfirmed();
    paymentPending();
  }
  return { orderId, status: "cancelled_order" as const, reservationReleased: true as const };
};
