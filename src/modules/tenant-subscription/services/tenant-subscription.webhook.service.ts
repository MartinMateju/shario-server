import Stripe from "stripe";

import { logger } from "@/config/logger.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
} from "../tenant-subscription.webhook-event.repository.js";
import {
  getInvoicePaymentRecoveryUpdate,
  type InvoicePaymentRecoveryUpdate,
} from "../tenant-subscription.payment-recovery.js";
import { getInvoiceBillingEmailIntent } from "../tenant-subscription.email-intent.js";
import type { TenantSubscriptionDocument } from "../tenant-subscription.types.js";
import { assertStripeSubscriptionContract } from "../tenant-subscription.stripe-contract.js";
import { enqueueTenantBillingEmail } from "./tenant-subscription.email.service.js";
import { getTenantBillingStripe } from "./tenant-subscription.stripe.service.js";
import { syncStripeSubscriptionSnapshotWithResult } from "./tenant-subscription.sync.service.js";

const getInvoiceSubscriptionId = (invoice: Stripe.Invoice): string | null => {
  if (!invoice.subscription) return null;

  return typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription.id;
};

const getScheduleSubscriptionId = (
  schedule: Stripe.SubscriptionSchedule,
): string | null => {
  if (!schedule.subscription) return null;

  return typeof schedule.subscription === "string"
    ? schedule.subscription
    : schedule.subscription.id;
};

const syncSubscriptionById = async ({
  subscriptionId,
  event,
  latestInvoiceId,
  paymentRecovery,
  completedCheckout,
}: {
  subscriptionId: string;
  event: Stripe.Event;
  latestInvoiceId?: string;
  paymentRecovery?: InvoicePaymentRecoveryUpdate | null;
  completedCheckout?: Parameters<
    typeof syncStripeSubscriptionSnapshotWithResult
  >[0]["completedCheckout"];
}): Promise<{
  subscription: TenantSubscriptionDocument;
  hadPaymentFailure: boolean;
  paymentEventApplied: boolean;
}> => {
  const stripeSubscription =
    await getTenantBillingStripe().subscriptions.retrieve(subscriptionId, {
      expand: [
        "items.data.price.currency_options",
        "items.data.price.product",
        ...(completedCheckout ? ["latest_invoice"] : []),
      ],
    });

  // Fail closed before the local subscription record or tenant entitlements
  // are mutated. Metadata alone is never authoritative for a paid plan.
  assertStripeSubscriptionContract({ stripeSubscription });

  // An invoice may arrive before Checkout completes. It cannot authorize a
  // new binding, so reconcile its current state from Stripe once Checkout does.
  const checkoutInvoice =
    completedCheckout && typeof stripeSubscription.latest_invoice === "object"
      ? stripeSubscription.latest_invoice
      : null;
  const checkoutInvoiceEventType = checkoutInvoice
    ? checkoutInvoice.paid || checkoutInvoice.status === "paid"
      ? "invoice.paid"
      : checkoutInvoice.last_finalization_error
        ? "invoice.finalization_failed"
        : checkoutInvoice.status === "uncollectible"
          ? "invoice.marked_uncollectible"
          : checkoutInvoice.status === "void"
            ? "invoice.voided"
            : checkoutInvoice.status === "open" &&
                (checkoutInvoice.attempt_count ?? 0) > 0
              ? "invoice.payment_failed"
              : null
    : null;
  const checkoutRecovery =
    checkoutInvoice && checkoutInvoiceEventType
      ? getInvoicePaymentRecoveryUpdate(
          checkoutInvoiceEventType,
          checkoutInvoice,
        )
      : null;
  const result = await syncStripeSubscriptionSnapshotWithResult({
    stripeSubscription,
    eventId: event.id,
    eventCreatedAt: event.created,
    latestInvoiceId: latestInvoiceId ?? checkoutInvoice?.id,
    paymentRecovery: paymentRecovery ?? checkoutRecovery,
    completedCheckout,
  });
  if (
    checkoutInvoice &&
    checkoutInvoiceEventType &&
    result.paymentEventApplied
  ) {
    const intent = getInvoiceBillingEmailIntent({
      eventType: checkoutInvoiceEventType,
      invoiceId: checkoutInvoice.id,
      attemptCount: Math.max(0, checkoutInvoice.attempt_count ?? 0),
      hadPaymentFailure: result.hadPaymentFailure,
    });
    if (intent)
      await enqueueTenantBillingEmail({
        subscription: result.subscription,
        intent,
      });
  }
  return result;
};

const processTenantBillingEvent = async (
  event: Stripe.Event,
): Promise<void> => {
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted" ||
    event.type === "customer.subscription.paused" ||
    event.type === "customer.subscription.resumed"
  ) {
    // Retrieve the latest Stripe snapshot so an out-of-order update event
    // cannot overwrite a newer subscription state with an older payload.
    await syncSubscriptionById({
      subscriptionId: event.data.object.id,
      event,
    });
    return;
  }

  if (event.type === "customer.subscription.trial_will_end") {
    await syncSubscriptionById({
      subscriptionId: event.data.object.id,
      event,
    });

    logger.info(
      {
        stripeEventId: event.id,
        stripeSubscriptionId: event.data.object.id,
      },
      "Tenant subscription trial will end soon.",
    );
    return;
  }

  if (event.type === "checkout.session.completed") {
    const checkout = event.data.object;
    if (checkout.mode !== "subscription") return;
    const subscriptionId =
      typeof checkout.subscription === "string"
        ? checkout.subscription
        : checkout.subscription?.id;

    const customerId =
      typeof checkout.customer === "string"
        ? checkout.customer
        : checkout.customer?.id;
    const tenantId = checkout.metadata?.tenantId;

    if (
      subscriptionId &&
      customerId &&
      tenantId &&
      checkout.client_reference_id === tenantId
    ) {
      await syncSubscriptionById({
        subscriptionId,
        event,
        completedCheckout: {
          id: checkout.id,
          tenantId,
          customerId,
          subscriptionId,
        },
      });
    } else {
      badRequest(
        "Tenant Checkout completion is missing its workspace identity.",
      );
    }
    return;
  }

  if (
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_succeeded" ||
    event.type === "invoice.payment_failed" ||
    event.type === "invoice.payment_action_required" ||
    event.type === "invoice.finalization_failed" ||
    event.type === "invoice.updated" ||
    event.type === "invoice.marked_uncollectible" ||
    event.type === "invoice.voided"
  ) {
    const invoice = event.data.object;
    const subscriptionId = getInvoiceSubscriptionId(invoice);

    if (subscriptionId) {
      const { subscription, hadPaymentFailure, paymentEventApplied } =
        await syncSubscriptionById({
          subscriptionId,
          event,
          latestInvoiceId: invoice.id,
          paymentRecovery: getInvoicePaymentRecoveryUpdate(event.type, invoice),
        });
      const emailIntent = paymentEventApplied
        ? getInvoiceBillingEmailIntent({
            eventType: event.type,
            invoiceId: invoice.id,
            attemptCount: Math.max(0, invoice.attempt_count ?? 0),
            hadPaymentFailure,
          })
        : null;

      if (emailIntent) {
        await enqueueTenantBillingEmail({ subscription, intent: emailIntent });
      }
    }

    if (event.type === "invoice.finalization_failed") {
      logger.warn(
        {
          stripeEventId: event.id,
          stripeInvoiceId: invoice.id,
        },
        "Tenant subscription invoice finalization failed.",
      );
    }
    return;
  }

  if (
    event.type === "subscription_schedule.updated" ||
    event.type === "subscription_schedule.aborted" ||
    event.type === "subscription_schedule.completed" ||
    event.type === "subscription_schedule.released" ||
    event.type === "subscription_schedule.canceled"
  ) {
    const subscriptionId = getScheduleSubscriptionId(event.data.object);

    if (subscriptionId) {
      await syncSubscriptionById({ subscriptionId, event });
    }
    return;
  }

  logger.debug(
    { stripeEvent: event.type, stripeEventId: event.id },
    "Ignored tenant billing event.",
  );
};

export const constructTenantBillingEvent = (
  rawBody: Buffer,
  signature: string,
): Stripe.Event => {
  const webhookSecret = process.env.STRIPE_BILLING_WEBHOOK_SECRET?.trim();

  if (!webhookSecret) {
    badRequest("STRIPE_BILLING_WEBHOOK_SECRET is not configured.");
  }

  return getTenantBillingStripe().webhooks.constructEvent(
    rawBody,
    signature,
    webhookSecret,
  );
};

export const handleTenantBillingEvent = async (
  event: Stripe.Event,
): Promise<void> => {
  const claimed = await claimStripeWebhookEvent({
    eventId: event.id,
    type: event.type,
    stripeCreatedAt: event.created,
  });

  if (!claimed) {
    logger.debug(
      { stripeEventId: event.id, stripeEvent: event.type },
      "Duplicate Stripe tenant billing event ignored.",
    );
    return;
  }

  try {
    await processTenantBillingEvent(event);
    await completeStripeWebhookEvent(event.id);
  } catch (error) {
    await failStripeWebhookEvent(event.id, error);
    throw error;
  }
};
