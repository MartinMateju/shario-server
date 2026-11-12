import type Stripe from "stripe";

import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";

export const MEMBERSHIP_STRIPE_FLOW = "customer_membership_v1";

const requestOptions = (connectedAccountId: string, idempotencyKey?: string) =>
  getConnectedAccountRequestOptions(
    connectedAccountId,
    idempotencyKey ? { idempotencyKey } : {},
  );

export const createMembershipCheckoutSession = async (input: {
  connectedAccountId: string;
  idempotencyKey: string;
  membershipId: string;
  tenantId: string;
  userId: string;
  userEmail: string;
  planId: string;
  planVersionId: string;
  name: string;
  description: string;
  currency: string;
  amountMinor: number;
  billing: any;
  successUrl: string;
  cancelUrl: string;
  expiresAt: number;
}): Promise<Stripe.Checkout.Session> => {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("Membership Checkout requires a positive minor-unit amount.");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error("Membership Checkout requires its persisted expiration timestamp.");
  }
  const metadata = {
    sharioFlow: MEMBERSHIP_STRIPE_FLOW,
    sharioTenantId: input.tenantId,
    sharioMembershipId: input.membershipId,
    sharioUserId: input.userId,
    sharioPlanId: input.planId,
    sharioPlanVersionId: input.planVersionId,
  };
  const recurring = input.billing.type === "recurring";
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: recurring ? "subscription" : "payment",
    customer_email: input.userEmail,
    client_reference_id: input.membershipId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // Retries must send identical parameters with the membership's Stripe key.
    expires_at: input.expiresAt,
    metadata,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: input.currency.toLowerCase(),
        unit_amount: input.amountMinor,
        product_data: {
          name: input.name,
          ...(input.description ? { description: input.description.slice(0, 500) } : {}),
          metadata: {
            sharioFlow: MEMBERSHIP_STRIPE_FLOW,
            sharioTenantId: input.tenantId,
            sharioPlanId: input.planId,
            sharioPlanVersionId: input.planVersionId,
          },
        },
        ...(recurring ? {
          recurring: {
            interval: input.billing.interval,
            interval_count: input.billing.intervalCount,
          },
        } : {}),
      },
    }],
    ...(recurring
      ? { subscription_data: { metadata } }
      : {
          payment_intent_data: { metadata },
          customer_creation: "always",
          invoice_creation: {
            enabled: true,
            invoice_data: { metadata },
          },
        }),
  } as Stripe.Checkout.SessionCreateParams;
  return getTenantPaymentStripe().checkout.sessions.create(
    params,
    requestOptions(input.connectedAccountId, input.idempotencyKey),
  );
};

export const retrieveMembershipCheckoutSession = (
  connectedAccountId: string,
  sessionId: string,
): Promise<Stripe.Checkout.Session> =>
  getTenantPaymentStripe().checkout.sessions.retrieve(
    sessionId,
    {
      expand: [
        "invoice",
        "payment_intent.latest_charge",
        "subscription.latest_invoice.payment_intent",
      ],
    },
    requestOptions(connectedAccountId),
  );

export const expireMembershipCheckoutSession = async (
  connectedAccountId: string,
  sessionId: string,
): Promise<void> => {
  await getTenantPaymentStripe().checkout.sessions.expire(
    sessionId,
    requestOptions(connectedAccountId),
  );
};

/** Recover a Session whose successful creation was interrupted before DB attach. */
export const findMembershipCheckoutSession = async (input: {
  connectedAccountId: string;
  tenantId: string;
  membershipId: string;
  createdAt?: Date;
}): Promise<Stripe.Checkout.Session | null> => {
  const createdAt = input.createdAt ? new Date(input.createdAt).getTime() : NaN;
  let startingAfter: string | undefined;
  let foundId: string | undefined;
  do {
    const page = await getTenantPaymentStripe().checkout.sessions.list({
      limit: 100,
      ...(Number.isFinite(createdAt) ? { created: { gte: Math.max(0, Math.floor(createdAt / 1000) - 300) } } : {}),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }, requestOptions(input.connectedAccountId));
    for (const checkout of page.data) {
      if (checkout.client_reference_id !== input.membershipId ||
          checkout.metadata?.sharioFlow !== MEMBERSHIP_STRIPE_FLOW ||
          checkout.metadata.sharioTenantId !== input.tenantId ||
          checkout.metadata.sharioMembershipId !== input.membershipId) continue;
      if (foundId && foundId !== checkout.id) {
        throw new Error("Multiple Stripe Checkout sessions require membership payment reconciliation.");
      }
      foundId = checkout.id;
    }
    if (!page.has_more) break;
    const lastId = page.data.at(-1)?.id;
    if (!lastId || lastId === startingAfter) throw new Error("Stripe Checkout pagination did not advance.");
    startingAfter = lastId;
  } while (true);
  return foundId ? retrieveMembershipCheckoutSession(input.connectedAccountId, foundId) : null;
};

export const retrieveMembershipSubscription = (
  connectedAccountId: string,
  subscriptionId: string,
): Promise<Stripe.Subscription> =>
  getTenantPaymentStripe().subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice.payment_intent"] },
    requestOptions(connectedAccountId),
  );

export const updateMembershipSubscriptionCancellation = (
  connectedAccountId: string,
  subscriptionId: string,
  cancelAtPeriodEnd: boolean,
  idempotencyKey?: string,
): Promise<Stripe.Subscription> =>
  getTenantPaymentStripe().subscriptions.update(
    subscriptionId,
    { cancel_at_period_end: cancelAtPeriodEnd },
    requestOptions(connectedAccountId, idempotencyKey),
  );

export const cancelMembershipSubscription = (
  connectedAccountId: string,
  subscriptionId: string,
  idempotencyKey?: string,
): Promise<Stripe.Subscription> =>
  getTenantPaymentStripe().subscriptions.cancel(
    subscriptionId,
    {},
    requestOptions(connectedAccountId, idempotencyKey),
  );

export const createMembershipBillingPortalSession = (input: {
  connectedAccountId: string;
  customerId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> =>
  getTenantPaymentStripe().billingPortal.sessions.create(
    { customer: input.customerId, return_url: input.returnUrl },
    requestOptions(input.connectedAccountId),
  );

export const retrieveMembershipInvoice = (
  connectedAccountId: string,
  invoiceId: string,
): Promise<Stripe.Invoice> =>
  getTenantPaymentStripe().invoices.retrieve(
    invoiceId,
    {},
    requestOptions(connectedAccountId),
  );

/**
 * Lists a bounded page of invoices for one membership Subscription directly
 * in the tenant's connected-account context.
 */
export const listMembershipSubscriptionInvoices = (
  connectedAccountId: string,
  subscriptionId: string,
  limit = 100,
): Promise<Stripe.ApiList<Stripe.Invoice>> =>
  getTenantPaymentStripe().invoices.list(
    {
      subscription: subscriptionId,
      limit: Math.max(1, Math.min(100, Math.trunc(limit))),
    },
    requestOptions(connectedAccountId),
  );
