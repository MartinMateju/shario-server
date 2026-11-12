import { randomUUID } from "node:crypto";

import mongoose from "mongoose";
import Stripe from "stripe";

import { couponService } from "@/modules/coupon/coupon.service.js";
import { ensurePaidOrderInvoice } from "@/modules/invoice/invoice.service.js";
import { getTenantPaymentStripeLivemode } from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import { emitBookingCreatedNotificationsForOrderSafely } from "@/modules/workspace-notifications/workspace-notification.business-events.js";

import {
  STRIPE_ALLOWED_COMPLETED_EVENTS,
  STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT,
} from "../checkout.constants.js";
import { getStripeOrderLeaseExpiry } from "../checkout.processing-claim.js";
import { checkoutRepository } from "../checkout.repository.js";
import {
  processCourseBookingsAfterPayment,
  processCreditPurchaseFromWebhook,
  processCreditsDiscountAfterPayment,
  processGuestIncreaseBookingsAfterPayment,
  processPromoCodesAfterPayment,
  processWorkshopBookingsAfterPayment,
} from "./checkout.webhook.service.js";

const stripe = new Stripe(process.env.STRIPE_KEY || "sk_test_missing", {
  timeout: 15_000,
  maxNetworkRetries: 2,
});

const COUPON_REFERENCE_PREFIX = "CO_";

type LegacyReference = {
  clientReference: string;
  durableReference: string;
  tenantId: string;
  isVoucher: boolean;
};

const hasConnectedAccount = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

const getLegacyReference = (
  session: Stripe.Checkout.Session,
): LegacyReference | null => {
  const clientReference = String(session.client_reference_id || "").trim();
  const tenantId = String(session.metadata?.tenantId || "").trim();
  const isVoucher = clientReference.startsWith(COUPON_REFERENCE_PREFIX);
  const durableReference = isVoucher
    ? clientReference.slice(COUPON_REFERENCE_PREFIX.length).trim()
    : clientReference;

  if (
    !clientReference ||
    !mongoose.Types.ObjectId.isValid(tenantId) ||
    !mongoose.Types.ObjectId.isValid(durableReference)
  ) {
    return null;
  }

  return {
    clientReference,
    durableReference,
    tenantId,
    isVoucher,
  };
};

const getExpectedFlow = (
  reference: LegacyReference,
  session: Stripe.Checkout.Session,
): "voucher-purchase" | "credit-purchase" | "order" => {
  if (reference.isVoucher) return "voucher-purchase";
  if (session.metadata?.orderType === "credit-purchase") {
    return "credit-purchase";
  }
  return "order";
};

const assertPlatformEventIntegrity = (
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
): LegacyReference => {
  if (hasConnectedAccount(event.account)) {
    throw new Error(
      "Legacy platform checkout cannot process a connected-account event.",
    );
  }

  const platformLivemode = getTenantPaymentStripeLivemode();

  if (event.livemode !== platformLivemode) {
    throw new Error("Legacy Stripe event does not match the platform key mode.");
  }

  if (session.livemode !== event.livemode) {
    throw new Error("Stripe event and legacy Checkout Session livemode mismatch.");
  }

  const reference = getLegacyReference(session);

  if (!reference) {
    throw new Error("Legacy Checkout Session has an invalid durable reference.");
  }

  /*
   * Old Sessions predate `sharioFlow`, so absence is expected. If a flow is
   * present, however, it must agree with the durable reference. This prevents
   * a newly namespaced Session from being reinterpreted as a different flow.
   */
  const flow = String(session.metadata?.sharioFlow || "").trim();
  const expectedFlow = getExpectedFlow(reference, session);

  if (flow && flow !== expectedFlow) {
    throw new Error("Legacy Checkout Session flow metadata is invalid.");
  }

  return reference;
};

const getPaidSessionSnapshot = (session: Stripe.Checkout.Session) => {
  const amountTotal = session.amount_total;
  const currency = normalizeStudioCommerceCurrency(session.currency);

  if (!Number.isSafeInteger(amountTotal) || amountTotal < 0) {
    throw new Error("Legacy Stripe Session has an invalid amount snapshot.");
  }

  return {
    amountTotal,
    currency,
    paymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null,
  };
};

const assertLegacyOrderSnapshot = ({
  snapshot,
  session,
  event,
  amountTotal,
  currency,
  orderId,
}: {
  snapshot: any;
  session: Stripe.Checkout.Session;
  event: Stripe.Event;
  amountTotal: number;
  currency: string;
  orderId: string;
}): void => {
  if (!snapshot) {
    throw new Error("Legacy Checkout Session has no durable order.");
  }

  const storedLivemode = snapshot.stripe?.livemode;
  const integrityMismatch =
    snapshot.currency !== currency ||
    snapshot.expectedAmountMinor !== amountTotal ||
    snapshot.stripe?.sessionId !== session.id ||
    hasConnectedAccount(snapshot.stripe?.connectedAccountId) ||
    (typeof storedLivemode === "boolean" &&
      storedLivemode !== event.livemode);

  if (integrityMismatch) {
    throw new Error(
      `Legacy Stripe payment snapshot mismatch for order ${orderId}.`,
    );
  }
};

export const isLegacyPlatformCheckoutWebhookEnabled = (): boolean =>
  process.env.LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED === "true";

export const legacyPlatformCheckoutWebhookService = {
  constructEvent({ rawBody, signature }) {
    return stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.WEBHOOK_SECRET,
    );
  },

  shouldProcess(event: Stripe.Event): boolean {
    if (!isLegacyPlatformCheckoutWebhookEnabled()) return false;
    if (hasConnectedAccount(event.account)) return false;

    const session = event?.data?.object as Stripe.Checkout.Session | undefined;
    if (!session || !getLegacyReference(session)) return false;

    if (event.type === STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT) {
      return session.status === "expired" && session.payment_status !== "paid";
    }

    if (!STRIPE_ALLOWED_COMPLETED_EVENTS.has(event.type)) return false;
    return session.payment_status === "paid";
  },

  async processEvent(event: Stripe.Event): Promise<void> {
    if (!isLegacyPlatformCheckoutWebhookEnabled()) return;

    const session = event.data.object as Stripe.Checkout.Session;
    const reference = assertPlatformEventIntegrity(event, session);
    const { amountTotal, currency, paymentIntentId } =
      getPaidSessionSnapshot(session);

    if (reference.isVoucher) {
      if (event.type === STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT) {
        await couponService.releaseExpiredLegacyPlatformCouponOrderFromWebhook({
          tenantId: reference.tenantId,
          session,
          livemode: event.livemode,
        });
        return;
      }

      await couponService.processLegacyPlatformCouponOrderFromWebhook({
        tenantId: reference.tenantId,
        session,
        eventId: event.id,
        livemode: event.livemode,
      });
      return;
    }

    const snapshot = await checkoutRepository.findOrderPaymentSnapshot({
      tenantId: reference.tenantId,
      orderId: reference.durableReference,
    });

    try {
      assertLegacyOrderSnapshot({
        snapshot,
        session,
        event,
        amountTotal,
        currency,
        orderId: reference.durableReference,
      });
    } catch (error) {
      if (snapshot && !hasConnectedAccount(snapshot.stripe?.connectedAccountId)) {
        await checkoutRepository.markOrderFailed({
          tenantId: reference.tenantId,
          orderId: reference.durableReference,
          error,
        });
      }
      throw error;
    }

    if (event.type === STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT) {
      await checkoutRepository.releaseExpiredLegacyPlatformStripeOrder({
        tenantId: reference.tenantId,
        orderId: reference.durableReference,
        sessionId: session.id,
        currency,
        amountTotal,
        livemode: event.livemode,
      });
      return;
    }

    if (
      snapshot.status === "processed_order" ||
      snapshot.stripe?.processedEventIds?.includes(event.id)
    ) {
      return;
    }

    const claimToken = randomUUID();
    const claimNow = new Date();
    const claimedOrder =
      await checkoutRepository.claimLegacyPlatformStripeOrder({
        tenantId: reference.tenantId,
        orderId: reference.durableReference,
        eventId: event.id,
        claimToken,
        now: claimNow,
        leaseExpiresAt: getStripeOrderLeaseExpiry(claimNow),
        session: {
          id: session.id,
          payment_intent: paymentIntentId,
          currency,
          amount_total: amountTotal,
          livemode: event.livemode,
        },
      });

    if (!claimedOrder) {
      const current = await checkoutRepository.findOrderPaymentSnapshot({
        tenantId: reference.tenantId,
        orderId: reference.durableReference,
      });

      if (
        current?.status === "processed_order" ||
        current?.stripe?.processedEventIds?.includes(event.id)
      ) {
        return;
      }

      if (hasConnectedAccount(current?.stripe?.connectedAccountId)) {
        throw new Error(
          "Legacy platform checkout cannot claim a connected-account order.",
        );
      }

      throw new Error(
        `Legacy Stripe order ${reference.durableReference} is already being processed; retry after the active lease.`,
      );
    }

    try {
      const isCreditPurchase =
        Number(claimedOrder.creditPurchase?.amount || 0) > 0;

      if (isCreditPurchase) {
        await processCreditPurchaseFromWebhook({
          tenantId: reference.tenantId,
          order: claimedOrder,
        });
      } else {
        const bookingResults = await Promise.allSettled([
          processWorkshopBookingsAfterPayment(claimedOrder, {
            tenantId: reference.tenantId,
          }),
          processCourseBookingsAfterPayment(claimedOrder, {
            tenantId: reference.tenantId,
          }),
          processGuestIncreaseBookingsAfterPayment(claimedOrder, {
            tenantId: reference.tenantId,
          }),
        ]);
        const bookingFailure = bookingResults.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );

        if (bookingFailure) throw bookingFailure.reason;

        await processPromoCodesAfterPayment(claimedOrder, {
          tenantId: reference.tenantId,
        });
        await processCreditsDiscountAfterPayment({
          tenantId: reference.tenantId,
          order: claimedOrder,
          session,
        });
      }

      const processed = await checkoutRepository.markOrderProcessed({
        tenantId: reference.tenantId,
        orderId: claimedOrder._id,
        eventId: event.id,
        claimToken,
        paidAt: claimedOrder.paidAt || new Date(),
      });

      if (processed.modifiedCount !== 1) {
        throw new Error(
          "Legacy Stripe order processing lease was lost before commit.",
        );
      }
    } catch (error) {
      await checkoutRepository.markOrderProcessingRetryable({
        tenantId: reference.tenantId,
        orderId: claimedOrder._id,
        error,
        claimToken,
      });
      throw error;
    }

    await emitBookingCreatedNotificationsForOrderSafely({
      tenantId: reference.tenantId,
      order: claimedOrder,
    });

    await ensurePaidOrderInvoice({
      tenantId: reference.tenantId,
      orderId: String(claimedOrder._id),
    });
  },
};
