import type Stripe from "stripe";

import { logger } from "@/config/logger.js";
import { internalServerError } from "@/shared/http/httpErrors.js";

import {
  findTenantPaymentAccountByStripeAccount,
  updateTenantPaymentAccountFromWebhook,
} from "../tenant-payment-account.repository.js";
import {
  getTenantPaymentStripeLivemode,
  toTenantPaymentAccountSnapshot,
} from "../tenant-payment.stripe.gateway.js";
import { handleTenantPaymentCommerceEvent } from "./tenant-payment-commerce-event.service.js";

const commerceEventPrefixes = [
  "checkout.session.",
  "payment_intent.",
  "charge.",
  "refund.",
  "invoice.",
  "customer.subscription.",
] as const;

export const isTenantPaymentCommerceEvent = (eventType: string): boolean =>
  commerceEventPrefixes.some((prefix) => eventType.startsWith(prefix));

const getEventConnectedAccountId = (event: Stripe.Event): string | null => {
  if (typeof event.account === "string" && event.account.startsWith("acct_")) {
    return event.account;
  }

  return null;
};

const handleAccountUpdated = async (event: Stripe.Event): Promise<void> => {
  const account = event.data.object as Stripe.Account;

  if (account.object !== "account" || !account.id?.startsWith("acct_")) {
    internalServerError({
      message: "Stripe sent an invalid account.updated payload.",
      code: "STRIPE_CONNECT_ACCOUNT_EVENT_INVALID",
    });
  }

  const eventAccountId = getEventConnectedAccountId(event);

  if (eventAccountId && eventAccountId !== account.id) {
    internalServerError({
      message: "Stripe Connect event account context does not match its payload.",
      code: "STRIPE_CONNECT_ACCOUNT_CONTEXT_MISMATCH",
    });
  }

  const updated = await updateTenantPaymentAccountFromWebhook({
    stripeAccountId: account.id,
    eventCreated: event.created,
    snapshot: toTenantPaymentAccountSnapshot(account),
  });

  if (updated) {
    return;
  }

  const knownAccount = await findTenantPaymentAccountByStripeAccount(account.id);

  if (knownAccount) {
    logger.debug(
      { eventId: event.id, stripeAccountId: account.id },
      "Ignored an out-of-order Stripe connected account event.",
    );
    return;
  }

  // Acknowledging an account event that cannot be mapped is intentional. We
  // never create tenant ownership from untrusted webhook metadata; operations
  // can reconcile the account safely from Stripe if needed.
  logger.warn(
    { eventId: event.id, stripeAccountId: account.id },
    "Received a Stripe account event for an unknown connected account.",
  );
};

export const handleTenantPaymentConnectEvent = async (
  event: Stripe.Event,
): Promise<void> => {
  if (event.livemode !== getTenantPaymentStripeLivemode()) {
    internalServerError({
      message: "Stripe Connect event mode does not match platform mode.",
      code: "STRIPE_CONNECT_MODE_MISMATCH",
    });
  }

  if (event.type === "account.updated") {
    await handleAccountUpdated(event);
    return;
  }

  if (isTenantPaymentCommerceEvent(event.type)) {
    if (!getEventConnectedAccountId(event)) {
      internalServerError({
        message: "Stripe commerce event is missing its connected account.",
        code: "STRIPE_CONNECT_COMMERCE_ACCOUNT_MISSING",
      });
    }

    await handleTenantPaymentCommerceEvent(event);
    return;
  }

  logger.debug(
    { eventId: event.id, eventType: event.type },
    "Ignored an unsupported Stripe Connect event.",
  );
};
