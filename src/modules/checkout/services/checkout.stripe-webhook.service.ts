import { getTenantPaymentStripe } from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { Order } from "@/modules/order/order.model.js";
import { releaseBookingExtensionHolds } from "@/modules/booking/booking.extension.service.js";
import { processBookingPaymentRefundEvent } from "@/modules/booking/services/booking-payment-refund.service.js";
import { commitCheckoutVouchers } from "./checkout.voucher.service.js";
import { randomUUID } from "node:crypto";

import mongoose from "mongoose";
import Stripe from "stripe";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";

import { couponService } from "@/modules/coupon/coupon.service.js";
import { processVoucherRefundEvent } from "@/modules/coupon/voucher-refund.service.js";
import { checkoutRepository } from "../checkout.repository.js";
import {
  STRIPE_ALLOWED_COMPLETED_EVENTS,
  STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT,
} from "../checkout.constants.js";
import {
  processCourseBookingsAfterPayment,
  processCreditPurchaseFromWebhook,
  processCreditsDiscountAfterPayment,
  processGuestIncreaseBookingsAfterPayment,
  processPromoCodesAfterPayment,
  processWorkshopBookingsAfterPayment,
} from "./checkout.webhook.service.js";
import { ensurePaidOrderInvoice } from "@/modules/invoice/invoice.service.js";
import { getStripeOrderLeaseExpiry } from "../checkout.processing-claim.js";
import { findTenantPaymentAccountByStripeAccount } from "@/modules/tenant-payments/tenant-payment-account.repository.js";
import { emitBookingCreatedNotificationsForOrderSafely } from "@/modules/workspace-notifications/workspace-notification.business-events.js";
import {
  claimWaitlistOrderForWebhook,
  confirmProcessedWaitlistReplay,
  confirmWaitlistOrderFromWebhook,
  expireWaitlistOrderAfterStripeSession,
  getWaitlistOrderDisposition,
  lockWaitlistSessionForFulfillment,
  markLateWaitlistPaymentRefunded,
  releaseWaitlistWebhookClaim,
} from "@/modules/waitlist/waitlist.checkout.service.js";
import { promoteWaitlistEntry } from "@/modules/waitlist/waitlist.service.js";

const stripe = new Stripe(process.env.STRIPE_KEY || "sk_test_missing", {
  timeout: 15_000,
  maxNetworkRetries: 2,
});

const finalizeExtensionRefund = async ({
  tenantId,
  order,
  eventId,
  refund,
}: any) => {
  const paymentIntent =
    typeof refund.payment_intent === "string"
      ? refund.payment_intent
      : refund.payment_intent?.id;
  if (
    !refund.id ||
    paymentIntent !== order.stripe?.paymentIntentId ||
    refund.amount !== order.expectedAmountMinor ||
    normalizeStudioCommerceCurrency(refund.currency) !== order.currency
  )
    throw new Error(
      "Extension refund does not match its immutable payment snapshot.",
    );
  if (refund.status !== "succeeded")
    throw new Error(
      `Extension refund ${refund.id} is ${refund.status}; manual review or provider confirmation is required.`,
    );
  await mongoose.connection.transaction(async (session) => {
    await releaseBookingExtensionHolds({
      tenantId,
      orderId: order._id,
      session,
    });
    await Order.updateOne(
      { _id: order._id, tenant: tenantId },
      {
        $set: {
          status: "cancelled_order",
          isPaid: true,
          paidAmountMinor: refund.amount,
          "bookingExtension.refundId": refund.id,
          "bookingExtension.refundStatus": "succeeded",
          note: "Unfulfilled booking extension refunded to card.",
        },
        $addToSet: { "stripe.processedEventIds": eventId },
        $unset: {
          "stripe.processingClaimToken": 1,
          "stripe.processingEventId": 1,
          "stripe.processingClaimedAt": 1,
          "stripe.processingLeaseExpiresAt": 1,
        },
      },
      { session },
    );
  });
};

const refundUnfulfilledBookingExtension = async ({
  tenantId,
  order,
  eventId,
  paymentIntentId,
  amountTotal,
  connectedAccountId,
  claimToken,
}: any) => {
  // Refund intent is irreversible, including when the provider's response is
  // lost. Every retry uses the same key and can only reconcile the refund.
  await Order.updateOne(
    {
      _id: order._id,
      tenant: tenantId,
      "bookingExtension.refundStatus": { $in: ["", null] },
    },
    { $set: { "bookingExtension.refundStatus": "requested" } },
  );
  try {
    const previous = await Order.findOne({
      _id: order._id,
      tenant: tenantId,
    }).lean();
    const refundId = previous?.bookingExtension?.refundId;
    const options = { stripeAccount: connectedAccountId };
    if (!paymentIntentId)
      throw new Error(
        "The extension payment has no PaymentIntent to refund safely.",
      );
    const refund = refundId
      ? await getTenantPaymentStripe().refunds.retrieve(refundId, options)
      : await getTenantPaymentStripe().refunds.create(
          {
            payment_intent: paymentIntentId,
            amount: amountTotal,
            metadata: {
              sharioManaged: "true",
              tenantId,
              orderId: String(order._id),
              reason: "booking_extension_unfulfilled",
            },
          },
          {
            ...options,
            idempotencyKey: `booking-extension-unfulfilled:${String(order._id)}`,
          },
        );
    await Order.updateOne(
      { _id: order._id, tenant: tenantId },
      {
        $set: {
          "bookingExtension.refundId": refund.id,
          "bookingExtension.refundStatus": refund.status || "pending",
        },
      },
    );
    await finalizeExtensionRefund({
      tenantId,
      order: previous,
      eventId,
      refund,
    });
  } catch (error) {
    await checkoutRepository.markOrderProcessingRetryable({
      tenantId,
      orderId: order._id,
      error,
      claimToken,
    });
    throw error;
  }
};

const processExtensionRefundUpdate = async (event: Stripe.Event) => {
  const refund = event.data.object as Stripe.Refund;
  if (
    refund.metadata?.sharioManaged !== "true" ||
    refund.metadata?.reason !== "booking_extension_unfulfilled"
  )
    return false;
  const tenantId = String(refund.metadata.tenantId || "");
  const orderId = String(refund.metadata.orderId || "");
  if (!mongoose.isValidObjectId(tenantId) || !mongoose.isValidObjectId(orderId))
    throw new Error("Extension refund metadata is invalid.");
  const order = await Order.findOne({
    _id: orderId,
    tenant: tenantId,
    bookingExtension: { $ne: null },
  }).lean();
  if (
    !order ||
    order.stripe?.connectedAccountId !== event.account ||
    order.stripe?.livemode !== event.livemode ||
    (order.bookingExtension?.refundId &&
      order.bookingExtension.refundId !== refund.id)
  )
    throw new Error(
      "Extension refund event does not match its payment account.",
    );
  if (
    order.status === "cancelled_order" &&
    order.bookingExtension?.refundStatus === "succeeded"
  )
    return true;
  if (!order.bookingExtension?.refundStatus)
    throw new Error("Extension refund has no recorded refund intent.");
  await finalizeExtensionRefund({ tenantId, order, eventId: event.id, refund });
  return true;
};

const WAITLIST_REFUND_EVENTS = new Set(["refund.updated", "refund.failed"]);

const finalizeSucceededWaitlistRefund = async ({
  tenantId,
  orderId,
  eventId,
  paymentIntentId,
  amountMinor,
  currency,
  refundId,
  entry,
  sessionCancelled,
}: {
  tenantId: string;
  orderId: string;
  eventId: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  refundId: string;
  entry: any;
  sessionCancelled: boolean;
}) => {
  await checkoutRepository.releaseCourseCapacity({
    tenantId,
    orderId,
    bookingIds: [String(entry.courseSession)],
  });
  await markLateWaitlistPaymentRefunded({
    tenantId,
    orderId,
    refundId,
    amountMinor,
    currency,
    ...(sessionCancelled
      ? {
          terminalState: "cancelled" as const,
          reason: "Class cancelled or rescheduled; payment refunded.",
        }
      : {}),
  });
  await checkoutRepository.markLateWaitlistOrderRefunded({
    tenantId,
    orderId,
    eventId,
    paymentIntentId,
    paidAmountMinor: amountMinor,
  });
  if (!sessionCancelled) {
    await promoteWaitlistEntry({
      tenantId,
      sessionId: String(entry.courseSession),
      automatic: true,
    });
  }
};

const refundWaitlistPaymentWithoutFulfillment = async ({
  tenantId,
  orderId,
  eventId,
  paymentIntentId,
  amountMinor,
  currency,
  connectedAccountId,
  entry,
  sessionCancelled = false,
}: {
  tenantId: string;
  orderId: string;
  eventId: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  connectedAccountId: string;
  entry: any;
  sessionCancelled?: boolean;
}) => {
  const options = { stripeAccount: connectedAccountId };
  const previous = await checkoutRepository.findWaitlistRefundSnapshot({
    tenantId,
    orderId,
  });
  const previousRefundId = String(previous?.waitlistRefund?.refundId ?? "");
  const refund = previousRefundId
    ? await stripe.refunds.retrieve(previousRefundId, options)
    : await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          reason: "requested_by_customer",
          metadata: {
            sharioManaged: "true",
            tenantId,
            orderId,
            reason: sessionCancelled
              ? "waitlist_session_cancelled"
              : "waitlist_offer_expired",
          },
        },
        {
          ...options,
          idempotencyKey: `waitlist-unfulfilled-refund:${orderId}`,
        },
      );
  await checkoutRepository.recordWaitlistRefundAttempt({
    tenantId,
    orderId,
    refundId: refund.id,
    status: String(refund.status ?? ""),
    amountMinor:
      Number.isSafeInteger(refund.amount) && refund.amount >= 0
        ? refund.amount
        : null,
  });
  if (refund.status !== "succeeded") {
    throw new Error(
      `Waitlist refund ${refund.id} is ${String(refund.status)}; fulfillment remains blocked until Stripe confirms success.`,
    );
  }
  await finalizeSucceededWaitlistRefund({
    tenantId,
    orderId,
    eventId,
    paymentIntentId,
    refundId: refund.id,
    amountMinor,
    currency,
    entry,
    sessionCancelled,
  });
};

const processWaitlistRefundUpdate = async (
  event: Stripe.Event,
): Promise<void> => {
  const refund = event.data.object as Stripe.Refund;
  const tenantId = String(refund.metadata?.tenantId ?? "");
  const orderId = String(refund.metadata?.orderId ?? "");
  const connectedAccountId =
    typeof event.account === "string" ? event.account.trim() : "";
  if (
    !connectedAccountId.startsWith("acct_") ||
    !mongoose.Types.ObjectId.isValid(tenantId) ||
    !mongoose.Types.ObjectId.isValid(orderId)
  ) {
    throw new Error("Waitlist refund event has invalid tenant/order identity.");
  }
  const paymentAccount =
    await findTenantPaymentAccountByStripeAccount(connectedAccountId);
  if (!paymentAccount || String(paymentAccount.tenant) !== tenantId) {
    throw new Error("Waitlist refund account does not belong to its tenant.");
  }

  const snapshot = await checkoutRepository.findWaitlistRefundSnapshot({
    tenantId,
    orderId,
  });
  const amountMinor = Number(refund.amount);
  const currency = normalizeStudioCommerceCurrency(refund.currency);
  if (
    !snapshot?.waitlist?.entryId ||
    String(snapshot.waitlistRefund?.refundId ?? "") !== refund.id ||
    String(snapshot.stripe?.connectedAccountId ?? "") !== connectedAccountId ||
    normalizeStudioCommerceCurrency(snapshot.currency) !== currency ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    Number(snapshot.waitlistRefund?.amountMinor) !== amountMinor
  ) {
    throw new Error("Waitlist refund event does not match its durable order.");
  }

  await checkoutRepository.recordWaitlistRefundAttempt({
    tenantId,
    orderId,
    refundId: refund.id,
    status: String(refund.status ?? ""),
    amountMinor,
  });
  if (refund.status !== "succeeded") return;

  const disposition = await getWaitlistOrderDisposition({ tenantId, orderId });
  if (disposition.kind === "not_waitlist") {
    throw new Error("Waitlist refund has no matching entry.");
  }
  const paymentIntentId =
    typeof refund.payment_intent === "string"
      ? refund.payment_intent
      : refund.payment_intent?.id;
  if (!paymentIntentId) {
    throw new Error("Waitlist refund is missing its PaymentIntent.");
  }
  await finalizeSucceededWaitlistRefund({
    tenantId,
    orderId,
    eventId: event.id,
    paymentIntentId,
    amountMinor,
    currency,
    refundId: refund.id,
    entry: disposition.entry,
    sessionCancelled: refund.metadata?.reason === "waitlist_session_cancelled",
  });
};

export const stripeWebhookService = {
  constructEvent({ rawBody, signature }) {
    return stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.WEBHOOK_SECRET,
    );
  },

  shouldProcess(event) {
    const data = event?.data?.object;
    const eventType = event?.type;

    // Older voucher charges have no Shario metadata. Reconciliation checks the
    // connected account and durable order/payment binding before any mutation.
    if (eventType === "charge.refunded")
      return Boolean(
        event?.account && data?.object === "charge" && data?.payment_intent,
      );
    if (
      WAITLIST_REFUND_EVENTS.has(eventType) &&
      event?.account &&
      data?.object === "refund" &&
      ["failed", "canceled"].includes(data?.status)
    )
      return true;

    // A full-dashboard connected account can create its own Checkout Sessions.
    // The platform webhook must ignore those rather than repeatedly failing
    // them as malformed Shario orders.
    if (data?.metadata?.sharioManaged !== "true") return false;

    if (WAITLIST_REFUND_EVENTS.has(eventType)) {
      return (
        data?.object === "refund" || String(data?.id ?? "").startsWith("re_")
      );
    }

    if (eventType === STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT) {
      return data?.status === "expired" && data?.payment_status !== "paid";
    }

    if (!STRIPE_ALLOWED_COMPLETED_EVENTS.has(eventType)) return false;
    if (data?.payment_status && data.payment_status !== "paid") return false;
    return true;
  },

  async processEvent(event: Stripe.Event): Promise<void> {
    if (event.type === "charge.refunded") {
      await processVoucherRefundEvent(event);
      return;
    }
    if (WAITLIST_REFUND_EVENTS.has(event.type)) {
      if (await processExtensionRefundUpdate(event)) return;
      if (await processBookingPaymentRefundEvent(event)) return;
      if (await processVoucherRefundEvent(event)) return;
      if ((event.data.object as Stripe.Refund).metadata?.sharioManaged !== "true")
        return;
      await processWaitlistRefundUpdate(event);
      return;
    }
    const session = event.data.object as Stripe.Checkout.Session;
    const clientRef = session.client_reference_id;

    if (!clientRef || typeof clientRef !== "string") {
      throw new Error("Shario Checkout Session is missing client_reference_id.");
    }

    const tenantId = String(session.metadata?.tenantId || "");
    const sharioFlow = String(session.metadata?.sharioFlow || "");
    const connectedAccountId =
      typeof event.account === "string" ? event.account.trim() : "";

    if (!connectedAccountId.startsWith("acct_")) {
      throw new Error(
        "Tenant commerce event is missing its connected account.",
      );
    }

    if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) {
      throw new Error("Missing tenantId in Stripe session metadata.");
    }

    const expectedFlow = clientRef.startsWith("CO_")
      ? "voucher-purchase"
      : session.metadata?.orderType === "credit-purchase"
        ? "credit-purchase"
        : "order";

    if (sharioFlow !== expectedFlow) {
      throw new Error("Shario Checkout Session flow metadata is invalid.");
    }

    const durableReference = clientRef.startsWith("CO_")
      ? clientRef.slice(3).trim()
      : clientRef;

    if (!mongoose.Types.ObjectId.isValid(durableReference)) {
      throw new Error(
        "Shario Checkout Session has an invalid durable reference.",
      );
    }

    const paymentAccount =
      await findTenantPaymentAccountByStripeAccount(connectedAccountId);

    if (!paymentAccount || String(paymentAccount.tenant) !== tenantId) {
      throw new Error(
        "Stripe connected account does not belong to the payment tenant.",
      );
    }

    if (session.livemode !== event.livemode) {
      throw new Error("Stripe event and Checkout Session livemode mismatch.");
    }

    if (event.type === STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT) {
      if (clientRef.startsWith("CO_")) {
        const couponOrderId = clientRef.slice(3).trim();

        await couponService.releaseExpiredCouponOrderFromWebhook({
          tenantId,
          couponOrderId,
          sessionId: session.id,
          connectedAccountId,
        });
        return;
      }

      const snapshot = await checkoutRepository.findOrderPaymentSnapshot({
        tenantId,
        orderId: clientRef,
      });

      if (
        !snapshot ||
        snapshot.stripe?.sessionId !== session.id ||
        snapshot.stripe?.connectedAccountId !== connectedAccountId ||
        snapshot.stripe?.livemode !== event.livemode
      ) {
        throw new Error(
          "Expired Stripe Session does not match its order snapshot.",
        );
      }

      const released = await checkoutRepository.releaseExpiredStripeOrder({
        tenantId,
        orderId: clientRef,
        sessionId: session.id,
        connectedAccountId,
      });

      if (released) {
        const expired = await expireWaitlistOrderAfterStripeSession({
          tenantId,
          orderId: clientRef,
          stripeSessionId: session.id,
        });
        if (expired) {
          await promoteWaitlistEntry({
            tenantId,
            sessionId: expired.sessionId,
            automatic: true,
          });
        }
      }

      return;
    }

    if (clientRef.startsWith("CO_")) {
      await couponService.processCouponOrderFromWebhook({
        tenantId,
        session,
        connectedAccountId,
        eventId: event.id,
        livemode: event.livemode,
        paidAt: new Date(event.created * 1000),
      });

      return;
    }

    const amountTotal = session.amount_total;
    const currency = normalizeStudioCommerceCurrency(session.currency);

    if (!Number.isSafeInteger(amountTotal) || amountTotal < 0) {
      throw new Error("Stripe session has an invalid paid amount.");
    }

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null;

    const snapshot = await checkoutRepository.findOrderPaymentSnapshot({
      tenantId,
      orderId: clientRef,
    });

    if (!snapshot) {
      throw new Error("Shario Checkout Session has no durable order.");
    }

    if (
      Number(snapshot.creditPurchase?.amount || 0) > 0 &&
      (session.status !== "complete" || session.payment_status !== "paid")
    ) {
      throw new Error(
        "Credit purchase requires a completed and paid Stripe Session.",
      );
    }

    if (
      snapshot.voucherRedemptions?.length &&
      (session.status !== "complete" || session.payment_status !== "paid")
    ) {
      throw new Error(
        "Voucher checkout requires a completed and paid Stripe Session.",
      );
    }

    if (
      snapshot.status === "processed_order" ||
      (snapshot.bookingExtension?.refundStatus === "succeeded" && snapshot.status === "cancelled_order") ||
      snapshot.stripe?.processedEventIds?.includes(event.id)
    ) {
      return;
    }

    const integrityError =
      snapshot.currency !== currency ||
      snapshot.expectedAmountMinor !== amountTotal ||
      snapshot.stripe?.sessionId !== session.id ||
      snapshot.stripe?.connectedAccountId !== connectedAccountId ||
      snapshot.stripe?.livemode !== event.livemode
        ? new Error(`Stripe payment snapshot mismatch for order ${clientRef}.`)
        : null;

    if (integrityError) {
      await checkoutRepository.markOrderFailed({
        tenantId,
        orderId: clientRef,
        error: integrityError,
      });
      throw integrityError;
    }

    // A payment can settle after its checkout was explicitly expired. The
    // cancelled hold must never become a booking again; return the captured
    // payment instead of waiting forever for an ineligible processing claim.
    if (snapshot.bookingExtension && snapshot.status === "cancelled_order") {
      await Order.updateOne({ _id: clientRef, tenant: tenantId }, { $set: {
        isPaid: true, paidAmountMinor: amountTotal,
        "stripe.paymentIntentId": paymentIntentId,
      } });
      await refundUnfulfilledBookingExtension({ tenantId, order: snapshot, eventId: event.id, paymentIntentId, amountTotal, connectedAccountId, claimToken: "" });
      return;
    }

    const waitlistClaim = await claimWaitlistOrderForWebhook({
      tenantId,
      orderId: clientRef,
    });

    if (waitlistClaim.kind === "busy") {
      throw new Error(
        `Waitlist order ${clientRef} is already being fulfilled; retry after the active lease.`,
      );
    }
    if (waitlistClaim.kind === "already_confirmed") return;

    if (waitlistClaim.kind === "refund") {
      if (!paymentIntentId) {
        throw new Error(
          "A late waitlist payment has no PaymentIntent to refund safely.",
        );
      }
      await refundWaitlistPaymentWithoutFulfillment({
        tenantId,
        orderId: clientRef,
        eventId: event.id,
        paymentIntentId,
        amountMinor: amountTotal,
        currency,
        connectedAccountId,
        entry: waitlistClaim.entry,
      });
      return;
    }

    const claimToken = randomUUID();
    const claimNow = new Date();
    const claimedOrder = await checkoutRepository.claimStripeOrder({
      tenantId,
      orderId: clientRef,
      eventId: event.id,
      claimToken,
      now: claimNow,
      leaseExpiresAt: getStripeOrderLeaseExpiry(claimNow),
      session: {
        id: session.id,
        payment_intent: paymentIntentId,
        currency,
        amount_total: amountTotal,
        connectedAccountId,
        livemode: event.livemode,
      },
    });

    if (!claimedOrder) {
      const current = await checkoutRepository.findOrderPaymentSnapshot({
        tenantId,
        orderId: clientRef,
      });

      if (
        current?.status === "processed_order" ||
        current?.stripe?.processedEventIds?.includes(event.id)
      ) {
        if (waitlistClaim.kind === "fulfill") {
          await confirmProcessedWaitlistReplay({
            tenantId,
            orderId: clientRef,
            claimToken: waitlistClaim.claimToken,
          });
        }
        return;
      }

      if (!current) {
        throw new Error(
          "Shario Checkout Session order disappeared during processing.",
        );
      }

      /*
       * Returning a successful webhook response while another live claim owns
       * this order can make Stripe stop retrying this event if that owner then
       * crashes. A retryable failure keeps delivery alive until the lease owner
       * commits or the lease expires and this event can safely take over.
       */
      if (waitlistClaim.kind === "fulfill") {
        await releaseWaitlistWebhookClaim({
          tenantId,
          orderId: clientRef,
          claimToken: waitlistClaim.claimToken,
        });
      }
      throw new Error(
        `Stripe order ${clientRef} is already being processed; retry after the active lease.`,
      );
    }

    try {
      if (claimedOrder.bookingExtension?.refundStatus || claimedOrder.bookingExtension?.refundId) {
        await refundUnfulfilledBookingExtension({ tenantId, order: claimedOrder, eventId: event.id, paymentIntentId, amountTotal, connectedAccountId, claimToken });
        return;
      }
      if (waitlistClaim.kind === "fulfill") {
        const mongoSession = await mongoose.startSession();
        try {
          await mongoSession.withTransaction(async () => {
            const sessionValid = await lockWaitlistSessionForFulfillment({
              tenantId,
              orderId: String(claimedOrder._id),
              entry: waitlistClaim.entry,
              session: mongoSession,
            });
            if (!sessionValid) {
              const lifecycleError: any = new Error(
                "Waitlist Class was cancelled or rescheduled before fulfillment.",
              );
              lifecycleError.code = "WAITLIST_SESSION_CHANGED";
              throw lifecycleError;
            }
            await processCourseBookingsAfterPayment(claimedOrder, {
              tenantId,
              session: mongoSession,
            });
            const confirmed = await confirmWaitlistOrderFromWebhook({
              tenantId,
              orderId: String(claimedOrder._id),
              claimToken: waitlistClaim.claimToken,
              session: mongoSession,
            });
            if (confirmed.modifiedCount !== 1) {
              throw new Error(
                "Waitlist fulfillment claim was lost before confirmation.",
              );
            }
            const processed = await checkoutRepository.markOrderProcessed({
              tenantId,
              orderId: claimedOrder._id,
              eventId: event.id,
              claimToken,
              paidAt: claimedOrder.paidAt || new Date(),
              session: mongoSession,
            });
            if (processed.modifiedCount !== 1) {
              throw new Error(
                "Stripe order processing lease was lost before commit.",
              );
            }
          });
        } finally {
          await mongoSession.endSession();
        }
      } else if (claimedOrder.bookingExtension) {
        // Original booking, extension hold, lifecycle outbox and paid order are
        // one atomic commit. A retry cannot see an applied but unprocessed extension.
        await mongoose.connection.transaction(async (mongoSession) => {
          await processWorkshopBookingsAfterPayment(claimedOrder, { tenantId, session: mongoSession });
          const processed = await checkoutRepository.markOrderProcessed({
            tenantId, orderId: claimedOrder._id, eventId: event.id, claimToken,
            paidAt: claimedOrder.paidAt || new Date(), session: mongoSession,
          });
          if (processed.modifiedCount !== 1)
            throw new Error("Stripe order processing lease was lost before extension commit.");
        });
      } else if (claimedOrder.voucherRedemptions?.length) {
        await mongoose.connection.transaction(async (mongoSession) => {
          // Voucher consumption and all booking fulfillment commit together.
          // Sequential calls are required inside a MongoDB transaction.
          await commitCheckoutVouchers({
            tenantId,
            order: claimedOrder,
            session: mongoSession,
            paymentState: "paid",
          });
          await processWorkshopBookingsAfterPayment(claimedOrder, {
            tenantId,
            session: mongoSession,
          });
          await processCourseBookingsAfterPayment(claimedOrder, {
            tenantId,
            session: mongoSession,
          });
          await processGuestIncreaseBookingsAfterPayment(claimedOrder, {
            tenantId,
            session: mongoSession,
          });
          const processed = await checkoutRepository.markOrderProcessed({
            tenantId,
            orderId: claimedOrder._id,
            eventId: event.id,
            claimToken,
            paidAt: claimedOrder.paidAt || new Date(),
            session: mongoSession,
          });
          if (processed.modifiedCount !== 1)
            throw new Error(
              "Stripe order processing lease was lost before voucher commit.",
            );
        });
      } else {
        const isCreditPurchase =
          Number(claimedOrder.creditPurchase?.amount || 0) > 0;

        if (isCreditPurchase) {
          await processCreditPurchaseFromWebhook({
            tenantId,
            order: claimedOrder,
          });
        } else {
          const bookingResults = await Promise.allSettled([
            processWorkshopBookingsAfterPayment(claimedOrder, { tenantId }),
            processCourseBookingsAfterPayment(claimedOrder, { tenantId }),
            processGuestIncreaseBookingsAfterPayment(claimedOrder, {
              tenantId,
            }),
          ]);
          const bookingFailure = bookingResults.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );

          if (bookingFailure) {
            throw bookingFailure.reason;
          }

          await processPromoCodesAfterPayment(claimedOrder, { tenantId });

          await processCreditsDiscountAfterPayment({
            tenantId,
            order: claimedOrder,
            session,
          });
        }

        const processed = await checkoutRepository.markOrderProcessed({
          tenantId,
          orderId: claimedOrder._id,
          eventId: event.id,
          claimToken,
          paidAt: claimedOrder.paidAt || new Date(),
        });
        if (processed.modifiedCount !== 1) {
          throw new Error(
            "Stripe order processing lease was lost before commit.",
          );
        }
      }
    } catch (error) {
      const extensionFailureCode = String((error as any)?.errorCode || (error as any)?.code || "");
      if (claimedOrder.bookingExtension && (/^CUSTOMER_BOOKING_EXTENSION_/.test(extensionFailureCode) || /^(LOCATION_|OPEN_STUDIO_)/.test(extensionFailureCode))) {
        await refundUnfulfilledBookingExtension({ tenantId, order: claimedOrder, eventId: event.id, paymentIntentId, amountTotal, connectedAccountId, claimToken });
        return;
      }
      /*
       * A paid Session must not become terminal because a downstream database
       * or notification dependency failed temporarily. Release the lease while
       * preserving the paid order as pending so Stripe's non-2xx retry can
       * claim and idempotently resume fulfillment.
       */
      await checkoutRepository.markOrderProcessingRetryable({
        tenantId,
        orderId: claimedOrder._id,
        error,
        claimToken,
      });

      if (waitlistClaim.kind === "fulfill") {
        await releaseWaitlistWebhookClaim({
          tenantId,
          orderId: clientRef,
          claimToken: waitlistClaim.claimToken,
        });
      }

      if (
        (error as any)?.code === "WAITLIST_SESSION_CHANGED" &&
        waitlistClaim.kind === "fulfill" &&
        paymentIntentId
      ) {
        await refundWaitlistPaymentWithoutFulfillment({
          tenantId,
          orderId: clientRef,
          eventId: event.id,
          paymentIntentId,
          amountMinor: amountTotal,
          currency,
          connectedAccountId,
          entry: waitlistClaim.entry,
          sessionCancelled: true,
        });
        return;
      }

      throw error;
    }

    if (!claimedOrder.bookingExtension) await emitBookingCreatedNotificationsForOrderSafely({
      tenantId,
      order: claimedOrder,
    });

    // Invoice automation is deliberately outside the payment-fulfillment
    // failure boundary. It records/retries its own failures and must never roll
    // a successfully paid order back to failed.
    await ensurePaidOrderInvoice({
      tenantId,
      orderId: String(claimedOrder._id),
    });
  },
};
