import type Stripe from "stripe";

import { stripeWebhookService } from "@/modules/checkout/services/checkout.stripe-webhook.service.js";
import { handleMembershipStripeEvent } from "@/modules/membership/services/membership-webhook.service.js";

/**
 * Dispatches tenant-commerce events delivered by Stripe's single Connect
 * webhook endpoint. Account lifecycle events are handled by the Connect core;
 * unrelated connected-account events are intentionally acknowledged/no-op.
 */
export const handleTenantPaymentCommerceEvent = async (
  event: Stripe.Event,
): Promise<void> => {
  if (await handleMembershipStripeEvent(event)) {
    return;
  }

  if (!stripeWebhookService.shouldProcess(event)) {
    return;
  }

  await stripeWebhookService.processEvent(event);
};
