import Stripe from "stripe";

import { internalServerError } from "@/shared/http/httpErrors.js";

import { TENANT_PAYMENT_CONTROLLER } from "./tenant-payment-account.constants.js";
import type { TenantPaymentAccountSnapshot } from "./tenant-payment-account.types.js";

let stripeClient: Stripe | null = null;

export const getTenantPaymentStripeLivemode = (): boolean => {
  const key = process.env.STRIPE_KEY?.trim() ?? "";
  return key.startsWith("sk_live_") || key.startsWith("rk_live_");
};

/**
 * Stripe platform client used for tenant commerce and Connect account
 * administration. Shario's own SaaS subscription module intentionally owns a
 * separate accessor even though both currently use the same platform secret.
 */
export const getTenantPaymentStripe = (): Stripe => {
  const secretKey = process.env.STRIPE_KEY?.trim();

  if (!secretKey) {
    internalServerError({
      message: "Tenant payments are not configured.",
      code: "TENANT_PAYMENTS_NOT_CONFIGURED",
    });
  }

  stripeClient ??= new Stripe(secretKey, {
    apiVersion: "2023-10-16",
    typescript: true,
    timeout: 15_000,
    maxNetworkRetries: 2,
  });

  return stripeClient;
};

export const getConnectedAccountRequestOptions = (
  stripeAccountId: string,
  options: Stripe.RequestOptions = {},
): Stripe.RequestOptions => {
  const accountId = stripeAccountId.trim();

  if (!accountId.startsWith("acct_")) {
    throw new Error("A valid Stripe connected account identifier is required.");
  }

  return {
    ...options,
    stripeAccount: accountId,
  };
};

export const buildConnectedAccountCreateParams = ({
  tenantId,
  tenantName,
  ownerEmail,
}: {
  tenantId: string;
  tenantName: string;
  ownerEmail?: string;
}): Stripe.AccountCreateParams => ({
  ...(ownerEmail?.trim()
    ? { email: ownerEmail.trim().toLowerCase() }
    : {}),
  metadata: {
    sharioTenantId: tenantId,
    sharioTenantName: tenantName.slice(0, 250),
  },
  controller: {
    fees: { payer: TENANT_PAYMENT_CONTROLLER.feesPayer },
    losses: { payments: TENANT_PAYMENT_CONTROLLER.lossesPayments },
    requirement_collection: TENANT_PAYMENT_CONTROLLER.requirementCollection,
    stripe_dashboard: { type: TENANT_PAYMENT_CONTROLLER.dashboardType },
  },
});

export const createTenantConnectedAccount = async ({
  tenantId,
  tenantName,
  ownerEmail,
  idempotencyKey,
}: {
  tenantId: string;
  tenantName: string;
  ownerEmail?: string;
  idempotencyKey: string;
}): Promise<Stripe.Account> =>
  getTenantPaymentStripe().accounts.create(
    buildConnectedAccountCreateParams({ tenantId, tenantName, ownerEmail }),
    { idempotencyKey },
  );

export const retrieveTenantConnectedAccount = async (
  stripeAccountId: string,
): Promise<Stripe.Account> =>
  getTenantPaymentStripe().accounts.retrieve(stripeAccountId);

export const createTenantConnectedAccountLink = async ({
  stripeAccountId,
  refreshUrl,
  returnUrl,
}: {
  stripeAccountId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<Stripe.AccountLink> =>
  getTenantPaymentStripe().accountLinks.create({
    account: stripeAccountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });

export const constructTenantPaymentConnectEvent = (
  rawBody: Buffer,
  signature: string,
): Stripe.Event => {
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();

  if (!webhookSecret) {
    internalServerError({
      message: "The Stripe Connect webhook is not configured.",
      code: "STRIPE_CONNECT_WEBHOOK_NOT_CONFIGURED",
    });
  }

  return getTenantPaymentStripe().webhooks.constructEvent(
    rawBody,
    signature,
    webhookSecret,
  );
};

const normalizeRequirementList = (value: string[] | null | undefined) =>
  [...new Set(value ?? [])].sort();

export const deriveTenantPaymentOnboardingStatus = (
  account: Stripe.Account,
): TenantPaymentAccountSnapshot["onboardingStatus"] => {
  const requirements = account.requirements;
  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const detailsSubmitted = account.details_submitted === true;
  const pendingVerification = requirements?.pending_verification ?? [];
  const currentlyDue = requirements?.currently_due ?? [];
  const pastDue = requirements?.past_due ?? [];

  if (detailsSubmitted && chargesEnabled && payoutsEnabled) {
    return "complete";
  }

  if (
    Boolean(requirements?.disabled_reason) ||
    pastDue.length > 0 ||
    (detailsSubmitted &&
      currentlyDue.length === 0 &&
      pendingVerification.length === 0 &&
      (!chargesEnabled || !payoutsEnabled))
  ) {
    return "restricted";
  }

  return "pending";
};

/**
 * Converts Stripe's Account into the deliberately small, non-sensitive
 * snapshot persisted by Shario. Requirement field names are retained so the UI
 * can explain status; KYC values and bank details never enter our database.
 */
export const toTenantPaymentAccountSnapshot = (
  account: Stripe.Account,
  now: Date = new Date(),
): TenantPaymentAccountSnapshot => ({
  stripeAccountId: account.id,
  onboardingStatus: deriveTenantPaymentOnboardingStatus(account),
  detailsSubmitted: account.details_submitted === true,
  chargesEnabled: account.charges_enabled === true,
  payoutsEnabled: account.payouts_enabled === true,
  ...(account.country ? { country: account.country.toUpperCase() } : {}),
  ...(account.default_currency
    ? { defaultCurrency: account.default_currency.toLowerCase() }
    : {}),
  // Stripe Account objects do not carry `livemode`; connected accounts live
  // in the mode of the platform key used to create/retrieve them.
  livemode: getTenantPaymentStripeLivemode(),
  requirements: {
    currentlyDue: normalizeRequirementList(account.requirements?.currently_due),
    eventuallyDue: normalizeRequirementList(
      account.requirements?.eventually_due,
    ),
    pastDue: normalizeRequirementList(account.requirements?.past_due),
    pendingVerification: normalizeRequirementList(
      account.requirements?.pending_verification,
    ),
    ...(account.requirements?.disabled_reason
      ? { disabledReason: account.requirements.disabled_reason }
      : {}),
  },
  lastSyncedAt: now,
});
