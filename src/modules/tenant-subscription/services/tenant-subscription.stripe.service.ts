import Stripe from "stripe";

import { logger } from "@/config/logger.js";
import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { getCurrentPlanVersion } from "@/modules/tenants/tenant.plan.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import {
  DEFAULT_PLATFORM_BILLING_CURRENCY,
  isPlatformBillingCurrency,
  type PlatformBillingCurrency,
} from "@/shared/money/currency.js";
import {
  badRequest,
  conflict,
  internalServerError,
} from "@/shared/http/httpErrors.js";

import {
  getBasePlanCatalog,
  getPlanChangeTiming,
  getStripePriceReference,
  isSelfServePlan,
  type StripePlanPriceReference,
  type StripePlanSelection,
  type PlanChangeTiming,
} from "../tenant-subscription.catalog.js";
import {
  getCommercialPriceSpec,
  getCommercialPriceCurrencies,
  isNewSaleCurrency,
  NEW_SALE_CURRENCIES,
} from "../tenant-subscription.commercial.js";
import { getTenantCheckoutTrialPolicy } from "../tenant-subscription.checkout-policy.js";
import {
  BILLING_INTERVAL,
  TENANT_SUBSCRIPTION_STATUS,
} from "../tenant-subscription.constants.js";
import type {
  BillingInterval,
  TenantSubscriptionDocument,
  TenantSubscriptionStatus,
} from "../tenant-subscription.types.js";
import {
  assertStripePriceContract,
  assertStripeSubscriptionContract,
  assertTenantBillingAutomaticTaxReady,
  getTenantBillingStripeKeyIssue,
  getTenantBillingStripeMode,
  isTenantBillingAutomaticTaxEnabled,
} from "../tenant-subscription.stripe-contract.js";
import { resolveTenantBillingPortalConfigurationId } from "../tenant-subscription.portal.js";
import { getTenantBillingUrl } from "../tenant-subscription.urls.js";
import { syncStripeSubscriptionSnapshot } from "./tenant-subscription.sync.service.js";

let stripeClient: Stripe | null = null;
const validatedSubscriptionSelections = new WeakMap<
  Stripe.Subscription,
  StripePlanSelection
>();

export const getTenantBillingStripe = (): Stripe => {
  const secretKey = process.env.STRIPE_KEY?.trim();

  if (!secretKey) {
    internalServerError("Tenant billing is not configured.");
  }

  const keyIssue = getTenantBillingStripeKeyIssue({ secretKey });

  if (keyIssue) {
    logger.error(
      { tenantBillingStripeMode: getTenantBillingStripeMode() },
      keyIssue,
    );
    internalServerError("Tenant billing Stripe mode is misconfigured.");
  }

  stripeClient ??= new Stripe(secretKey, {
    apiVersion: "2023-10-16",
    typescript: true,
    timeout: 15_000,
    maxNetworkRetries: 2,
  });
  return stripeClient;
};

const resolveStripePrice = async (
  stripe: Stripe,
  reference: StripePlanPriceReference | null,
): Promise<Stripe.Price | null> => {
  if (!reference) return null;

  if (reference.priceId) {
    return stripe.prices.retrieve(reference.priceId, {
      expand: ["currency_options", "product"],
    });
  }

  const matches = await stripe.prices.list({
    active: true,
    lookup_keys: [reference.lookupKey],
    limit: 1,
    expand: ["data.currency_options", "data.product"],
  });

  return matches.data[0] ?? null;
};

const getPriceCurrencyOptions = (
  price: Stripe.Price,
  allowedCurrencies: readonly PlatformBillingCurrency[] = NEW_SALE_CURRENCIES,
): Partial<
  Record<
    PlatformBillingCurrency,
    {
      currency: PlatformBillingCurrency;
      unitAmount: number | null;
      configured: true;
    }
  >
> => {
  const options: Partial<
    Record<
      PlatformBillingCurrency,
      {
        currency: PlatformBillingCurrency;
        unitAmount: number | null;
        configured: true;
      }
    >
  > = {};
  const defaultCurrency = price.currency.toUpperCase();

  if (
    isPlatformBillingCurrency(defaultCurrency) &&
    allowedCurrencies.includes(defaultCurrency)
  ) {
    options[defaultCurrency] = {
      currency: defaultCurrency,
      unitAmount: price.unit_amount,
      configured: true,
    };
  }

  for (const [currencyValue, value] of Object.entries(
    price.currency_options ?? {},
  )) {
    const currency = currencyValue.toUpperCase();

    if (
      !isPlatformBillingCurrency(currency) ||
      !allowedCurrencies.includes(currency)
    ) {
      continue;
    }

    options[currency] = {
      currency,
      unitAmount: value.unit_amount,
      configured: true,
    };
  }

  return options;
};

const getPriceUnitAmount = (
  price: Stripe.Price,
  currency: PlatformBillingCurrency,
): number | null =>
  getPriceCurrencyOptions(price)[currency]?.unitAmount ?? null;

const retrievePriceSummary = async (
  stripe: Stripe,
  reference: StripePlanPriceReference | null,
) => {
  if (!reference) {
    return {
      configured: false,
      priceId: null,
      lookupKey: null,
      unitAmount: null,
      currency: null,
      currencyOptions: {},
    };
  }

  try {
    const price = await resolveStripePrice(stripe, reference);

    if (!price || !price.active) {
      throw new Error("Stripe price is inactive or missing.");
    }

    const spec = getCommercialPriceSpec(
      reference.plan,
      reference.billingInterval,
      reference.planVersion,
    );

    if (!spec) {
      throw new Error("The current sale does not have a commercial contract.");
    }

    assertStripePriceContract({ price, spec });

    return {
      configured: true,
      priceId: price.id,
      lookupKey: reference.lookupKey,
      unitAmount: price.unit_amount,
      currency: price.currency.toUpperCase(),
      currencyOptions: getPriceCurrencyOptions(
        price,
        getCommercialPriceCurrencies(spec).filter(isNewSaleCurrency),
      ),
    };
  } catch {
    return {
      configured: false,
      priceId: null,
      lookupKey: reference.lookupKey,
      unitAmount: null,
      currency: null,
      currencyOptions: {},
    };
  }
};

const requireTargetPrice = async (
  plan: TenantPlan,
  billingInterval: BillingInterval,
  requestedCurrency?: PlatformBillingCurrency,
): Promise<{
  price: Stripe.Price;
  priceId: string;
  priceLookupKey: string;
  planVersion: number;
  offerId: string;
  billingCurrency: PlatformBillingCurrency;
}> => {
  if (!isSelfServePlan(plan) || plan === TENANT_PLAN.ENTERPRISE) {
    badRequest("Enterprise plans require a sales conversation.");
  }

  const planVersion = getCurrentPlanVersion(plan);
  const reference = getStripePriceReference(plan, billingInterval, planVersion);
  const spec = getCommercialPriceSpec(plan, billingInterval, planVersion);
  const billingCurrency: PlatformBillingCurrency =
    requestedCurrency ?? DEFAULT_PLATFORM_BILLING_CURRENCY;

  // Fail before any provider call when a code-owned price is unavailable.
  // Never choose another currency or a Stripe-only amount as a fallback.
  if (
    !isPlatformBillingCurrency(billingCurrency) ||
    !isNewSaleCurrency(billingCurrency) ||
    spec?.amounts[billingCurrency] === undefined
  ) {
    conflict(`This plan is not configured for ${billingCurrency} billing.`);
  }
  const price = await resolveStripePrice(getTenantBillingStripe(), reference);

  if (!reference || !price || !price.active || !spec) {
    conflict("This plan price is not configured yet.");
  }

  try {
    assertStripePriceContract({ price, spec });
  } catch (error) {
    logger.error(
      {
        err: error,
        plan,
        planVersion,
        billingInterval,
        stripePriceId: price.id,
      },
      "Rejected a Stripe Price that violates the Shario commercial contract.",
    );
    conflict("This plan price failed production safety validation.");
  }

  const currencyOptions = getPriceCurrencyOptions(
    price,
    getCommercialPriceCurrencies(spec),
  );

  if (
    !isPlatformBillingCurrency(billingCurrency) ||
    !isNewSaleCurrency(billingCurrency) ||
    !currencyOptions[billingCurrency]
  ) {
    conflict(`This plan is not configured for ${billingCurrency} billing.`);
  }

  return {
    price,
    priceId: price.id,
    priceLookupKey: reference.lookupKey,
    planVersion,
    offerId: spec.offerId,
    billingCurrency,
  };
};

const terminalStatuses: ReadonlySet<TenantSubscriptionStatus> = new Set([
  TENANT_SUBSCRIPTION_STATUS.CANCELED,
  TENANT_SUBSCRIPTION_STATUS.EXPIRED,
  TENANT_SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
]);

const getStripeSubscription = async (
  subscription: TenantSubscriptionDocument,
): Promise<Stripe.Subscription> => {
  const subscriptionId = subscription.stripe?.subscriptionId;

  if (!subscriptionId) {
    conflict("Choose a paid plan first.");
  }

  const stripeSubscription =
    await getTenantBillingStripe().subscriptions.retrieve(subscriptionId, {
      expand: [
        "latest_invoice.payment_intent",
        "items.data.price.currency_options",
        "items.data.price.product",
      ],
    });

  if (
    terminalStatuses.has(stripeSubscription.status as TenantSubscriptionStatus)
  ) {
    conflict("This subscription has ended. Start a new checkout instead.");
  }

  try {
    validatedSubscriptionSelections.set(
      stripeSubscription,
      assertStripeSubscriptionContract({ stripeSubscription }),
    );
  } catch (error) {
    logger.error(
      { err: error, stripeSubscriptionId: stripeSubscription.id },
      "Rejected a Stripe subscription that violates the Shario catalogue contract.",
    );
    conflict("The current subscription failed production safety validation.");
  }

  return stripeSubscription;
};

const getValidatedSubscriptionSelection = (
  stripeSubscription: Stripe.Subscription,
): StripePlanSelection => {
  const cached = validatedSubscriptionSelections.get(stripeSubscription);

  if (cached) return cached;

  const selection = assertStripeSubscriptionContract({ stripeSubscription });
  validatedSubscriptionSelections.set(stripeSubscription, selection);
  return selection;
};

const getSubscriptionItem = (
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem => {
  const item = subscription.items.data[0];

  if (!item) {
    conflict("The current Stripe subscription has no billable item.");
  }

  return item;
};

const getSubscriptionPlan = (
  stripeSubscription: Stripe.Subscription,
  _local: TenantSubscriptionDocument,
): TenantPlan => {
  return getValidatedSubscriptionSelection(stripeSubscription).plan;
};

const getSubscriptionInterval = (
  stripeSubscription: Stripe.Subscription,
  _local: TenantSubscriptionDocument,
): BillingInterval => {
  return getValidatedSubscriptionSelection(stripeSubscription).billingInterval;
};

const getSubscriptionBillingCurrency = (
  stripeSubscription: Stripe.Subscription,
  local: TenantSubscriptionDocument,
): PlatformBillingCurrency => {
  const stripeCurrency = stripeSubscription.currency?.toUpperCase();

  if (isPlatformBillingCurrency(stripeCurrency)) return stripeCurrency;
  if (local.billingCurrency) return local.billingCurrency;

  const priceCurrency =
    getSubscriptionItem(stripeSubscription).price.currency.toUpperCase();

  if (isPlatformBillingCurrency(priceCurrency)) return priceCurrency;

  conflict("The current subscription billing currency is unsupported.");
};

const getSubscriptionPlanVersion = (
  stripeSubscription: Stripe.Subscription,
  _local: TenantSubscriptionDocument,
): number => {
  return getValidatedSubscriptionSelection(stripeSubscription).planVersion;
};

const getScheduleId = (subscription: Stripe.Subscription): string | null => {
  if (!subscription.schedule) return null;

  return typeof subscription.schedule === "string"
    ? subscription.schedule
    : subscription.schedule.id;
};

const releaseSubscriptionSchedule = async (
  stripeSubscription: Stripe.Subscription,
): Promise<Stripe.Subscription> => {
  const scheduleId = getScheduleId(stripeSubscription);

  if (!scheduleId) return stripeSubscription;

  await getTenantBillingStripe().subscriptionSchedules.release(scheduleId);

  return getTenantBillingStripe().subscriptions.retrieve(
    stripeSubscription.id,
    {
      expand: [
        "latest_invoice.payment_intent",
        "items.data.price.currency_options",
        "items.data.price.product",
      ],
    },
  );
};

const getExpandedInvoice = (
  value: string | Stripe.Invoice | null,
): Stripe.Invoice | null => {
  return value && typeof value !== "string" ? value : null;
};

const serializeInvoice = (invoice: Stripe.Invoice) => ({
  id: invoice.id,
  number: invoice.number,
  status: invoice.status,
  createdAt: new Date(invoice.created * 1000),
  periodStart: new Date(invoice.period_start * 1000),
  periodEnd: new Date(invoice.period_end * 1000),
  currency: invoice.currency,
  amountDue: invoice.amount_due,
  amountPaid: invoice.amount_paid,
  amountRemaining: invoice.amount_remaining,
  hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  invoicePdf: invoice.invoice_pdf ?? null,
});

export const getSubscriptionPlanCatalog = async () => {
  const stripe = getTenantBillingStripe();

  return Promise.all(
    getBasePlanCatalog().map(async (plan) => {
      if (!plan.selfServe) {
        return {
          ...plan,
          prices: {
            monthly: await retrievePriceSummary(stripe, null),
            yearly: await retrievePriceSummary(stripe, null),
          },
        };
      }

      const [monthly, yearly] = await Promise.all([
        retrievePriceSummary(
          stripe,
          getStripePriceReference(
            plan.id,
            BILLING_INTERVAL.MONTHLY,
            plan.version,
          ),
        ),
        retrievePriceSummary(
          stripe,
          getStripePriceReference(
            plan.id,
            BILLING_INTERVAL.YEARLY,
            plan.version,
          ),
        ),
      ]);

      return {
        ...plan,
        prices: { monthly, yearly },
      };
    }),
  );
};

export const createTenantCheckout = async ({
  tenantId,
  tenantName,
  tenantSlug,
  ownerEmail,
  subscription,
  plan,
  billingInterval,
  billingCurrency,
  locale,
}: {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  ownerEmail: string;
  subscription: TenantSubscriptionDocument;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  billingCurrency?: PlatformBillingCurrency;
  locale: string;
}) => {
  const trialPolicy = getTenantCheckoutTrialPolicy({
    status: subscription.status,
    trialEndsAt: subscription.trialEndsAt,
  });

  if (!trialPolicy.allowed) {
    conflict(
      "Plan checkout is unavailable during the final 48 hours of the trial. No charge was made; return after the trial ends.",
    );
  }

  if (
    subscription.stripe.subscriptionId &&
    terminalStatuses.has(subscription.status) &&
    !Number.isFinite(subscription.stripe.subscriptionCreatedAt) &&
    !Number.isFinite(subscription.currentPeriodStart?.getTime())
  ) {
    conflict(
      "The previous subscription's billing history must be reconciled before starting a new checkout. No charge was made; contact support.",
    );
  }

  try {
    assertTenantBillingAutomaticTaxReady();
  } catch (error) {
    logger.error(
      { err: error },
      "Tenant billing is not ready for live automatic tax calculation.",
    );
    internalServerError("Tenant billing tax calculation is not configured.");
  }

  const target = await requireTargetPrice(
    plan,
    billingInterval,
    billingCurrency ?? subscription.billingCurrency,
  );

  if (
    subscription.stripe.subscriptionId &&
    !terminalStatuses.has(subscription.status)
  ) {
    conflict("Use the plan-change flow for an existing subscription.");
  }

  const stripe = getTenantBillingStripe();
  let customerId = subscription.stripe?.customerId;

  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        name: tenantName,
        email: ownerEmail,
        preferred_locales: [locale === "cs" ? "cs" : "en"],
        metadata: { tenantId, tenantSlug },
      },
      {
        idempotencyKey: `tenant-customer:${tenantId}`,
      },
    );

    customerId = customer.id;
    subscription.stripe.customerId = customerId;
    await subscription.save();
  } else {
    await stripe.customers.update(customerId, {
      name: tenantName,
      email: ownerEmail,
      preferred_locales: [locale === "cs" ? "cs" : "en"],
      metadata: { tenantId, tenantSlug },
    });
  }

  const successUrl = new URL(
    getTenantBillingUrl({ tenantSlug, locale, checkout: "success" }),
  );
  successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
  const successUrlTemplate = successUrl
    .toString()
    .replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
  const trialEnd = trialPolicy.trialEnd;

  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      currency: target.billingCurrency.toLowerCase(),
      customer: customerId,
      client_reference_id: tenantId,
      line_items: [{ price: target.priceId, quantity: 1 }],
      payment_method_collection: "always",
      allow_promotion_codes: true,
      automatic_tax: { enabled: isTenantBillingAutomaticTaxEnabled() },
      billing_address_collection: "auto",
      tax_id_collection: { enabled: true },
      customer_update: {
        address: "auto",
      },
      locale: locale === "cs" ? "cs" : "en",
      success_url: successUrlTemplate,
      cancel_url: getTenantBillingUrl({
        tenantSlug,
        locale,
        checkout: "cancelled",
      }),
      metadata: {
        tenantId,
        tenantSlug,
        plan,
        planVersion: String(target.planVersion),
        offerId: target.offerId,
        billingInterval,
        billingCurrency: target.billingCurrency,
        priceLookupKey: target.priceLookupKey,
      },
      subscription_data: {
        ...(trialEnd !== null ? { trial_end: trialEnd } : {}),
        trial_settings: {
          end_behavior: { missing_payment_method: "pause" },
        },
        metadata: {
          tenantId,
          tenantSlug,
          plan,
          planVersion: String(target.planVersion),
          offerId: target.offerId,
          billingInterval,
          billingCurrency: target.billingCurrency,
          priceLookupKey: target.priceLookupKey,
        },
      },
    },
    {
      idempotencyKey: [
        "tenant-checkout",
        "managed-payments-basil",
        String(subscription._id),
        subscription.stripe.subscriptionId ?? "no-subscription",
        subscription.status,
        plan,
        target.planVersion,
        target.offerId,
        billingInterval,
        target.billingCurrency,
        subscription.trialEndsAt?.getTime() ?? "no-trial",
      ].join(":"),
      // Managed Payments requires Basil or later. Keep other billing operations
      // on their existing API version until their response contracts migrate.
      apiVersion: "2025-03-31.basil",
    },
  );

  return {
    kind: "checkout" as const,
    url: checkout.url,
  };
};

export const getTenantPaymentMethodSummary = async (
  subscription: TenantSubscriptionDocument,
) => {
  const customerId = subscription.stripe?.customerId;

  if (!customerId) return null;

  const stripe = getTenantBillingStripe();
  const customer = await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method"],
  });

  if ((customer as Stripe.DeletedCustomer).deleted) return null;

  const activeCustomer = customer as Stripe.Customer;
  let reference = activeCustomer.invoice_settings.default_payment_method;

  if (!reference && subscription.stripe?.subscriptionId) {
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe.subscriptionId,
      { expand: ["default_payment_method"] },
    );
    reference = stripeSubscription.default_payment_method;
  }
  const paymentMethod =
    typeof reference === "string"
      ? await stripe.paymentMethods.retrieve(reference)
      : reference;

  if (!paymentMethod) return null;

  if (paymentMethod.card) {
    return {
      type: "card",
      brand: paymentMethod.card.brand,
      last4: paymentMethod.card.last4,
      expiresMonth: paymentMethod.card.exp_month,
      expiresYear: paymentMethod.card.exp_year,
    };
  }

  if (paymentMethod.sepa_debit) {
    return {
      type: "sepa_debit",
      brand: null,
      last4: paymentMethod.sepa_debit.last4,
      expiresMonth: null,
      expiresYear: null,
    };
  }

  return {
    type: paymentMethod.type,
    brand: null,
    last4: null,
    expiresMonth: null,
    expiresYear: null,
  };
};

export const listTenantInvoices = async ({
  subscription,
  limit,
  startingAfter,
}: {
  subscription: TenantSubscriptionDocument;
  limit: number;
  startingAfter?: string;
}) => {
  const customerId = subscription.stripe?.customerId;

  if (!customerId) {
    return { invoices: [], hasMore: false, nextCursor: null };
  }

  const result = await getTenantBillingStripe().invoices.list({
    customer: customerId,
    limit,
    ...(startingAfter ? { starting_after: startingAfter } : {}),
  });
  const invoices = result.data.map(serializeInvoice);

  return {
    invoices,
    hasMore: result.has_more,
    nextCursor: result.has_more ? (invoices.at(-1)?.id ?? null) : null,
  };
};

const buildChangeContext = async ({
  subscription,
  plan,
  billingInterval,
  billingCurrency,
}: {
  subscription: TenantSubscriptionDocument;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  billingCurrency?: PlatformBillingCurrency;
}) => {
  const stripeSubscription = await getStripeSubscription(subscription);
  const item = getSubscriptionItem(stripeSubscription);
  const currentPlan = getSubscriptionPlan(stripeSubscription, subscription);
  const currentPlanVersion = getSubscriptionPlanVersion(
    stripeSubscription,
    subscription,
  );
  const currentInterval = getSubscriptionInterval(
    stripeSubscription,
    subscription,
  );
  const currentCurrency = getSubscriptionBillingCurrency(
    stripeSubscription,
    subscription,
  );

  if (billingCurrency && billingCurrency !== currentCurrency) {
    conflict(
      "An active subscription cannot change currency during a plan change.",
    );
  }

  const target = await requireTargetPrice(
    plan,
    billingInterval,
    currentCurrency,
  );
  let timing = getPlanChangeTiming({
    currentPlan,
    currentInterval,
    targetPlan: plan,
    targetInterval: billingInterval,
  });

  if (timing === "none" && currentPlanVersion !== target.planVersion) {
    timing = "immediate";
  }

  if (timing === "none") {
    conflict("This is already the current subscription plan.");
  }

  return {
    ...target,
    stripeSubscription,
    item,
    currentPlan,
    currentInterval,
    currentCurrency,
    timing,
  };
};

export const previewTenantPlanChange = async ({
  subscription,
  plan,
  billingInterval,
  billingCurrency,
}: {
  subscription: TenantSubscriptionDocument;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  billingCurrency?: PlatformBillingCurrency;
}) => {
  const context = await buildChangeContext({
    subscription,
    plan,
    billingInterval,
    billingCurrency,
  });
  const { stripeSubscription, item, timing } = context;

  if (stripeSubscription.status === "trialing") {
    return {
      timing: "trial_end" as const,
      effectiveAt: stripeSubscription.trial_end
        ? new Date(stripeSubscription.trial_end * 1000)
        : new Date(stripeSubscription.current_period_end * 1000),
      amountDue: 0,
      currency: context.currentCurrency,
      lines: [],
    };
  }

  if (timing === "period_end") {
    return {
      timing,
      effectiveAt: new Date(stripeSubscription.current_period_end * 1000),
      amountDue: 0,
      recurringAmount: getPriceUnitAmount(
        context.price,
        context.billingCurrency,
      ),
      currency: context.billingCurrency,
      lines: [],
    };
  }

  const prorationDate = Math.floor(Date.now() / 1000);
  const customerId =
    typeof stripeSubscription.customer === "string"
      ? stripeSubscription.customer
      : stripeSubscription.customer.id;
  const preview = await getTenantBillingStripe().invoices.retrieveUpcoming({
    customer: customerId,
    subscription: stripeSubscription.id,
    subscription_items: [
      {
        id: item.id,
        price: context.priceId,
        quantity: item.quantity ?? 1,
      },
    ],
    subscription_proration_behavior: "always_invoice",
    subscription_proration_date: prorationDate,
  });

  return {
    timing: "immediate" as const,
    effectiveAt: new Date(),
    prorationDate,
    amountDue: preview.amount_due,
    currency: preview.currency,
    lines: preview.lines.data
      .filter((line) => line.proration || line.period.start === prorationDate)
      .map((line) => ({
        id: line.id,
        description: line.description,
        amount: line.amount,
        currency: line.currency,
        periodStart: new Date(line.period.start * 1000),
        periodEnd: new Date(line.period.end * 1000),
      })),
  };
};

const schedulePlanChange = async ({
  subscription,
  stripeSubscription: initialStripeSubscription,
  plan,
  billingInterval,
  priceId,
  planVersion,
  offerId,
  billingCurrency,
  priceLookupKey,
}: {
  subscription: TenantSubscriptionDocument;
  stripeSubscription: Stripe.Subscription;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  priceId: string;
  planVersion: number;
  offerId: string;
  billingCurrency: PlatformBillingCurrency;
  priceLookupKey: string;
}) => {
  const stripe = getTenantBillingStripe();
  const stripeSubscription = await releaseSubscriptionSchedule(
    initialStripeSubscription,
  );
  const currentItems = stripeSubscription.items.data.map((item) => ({
    price: item.price.id,
    quantity: item.quantity ?? 1,
    ...(item.tax_rates.length
      ? { tax_rates: item.tax_rates.map((taxRate) => taxRate.id) }
      : {}),
  }));
  const discounts = stripeSubscription.discounts.map((discount) => ({
    discount: typeof discount === "string" ? discount : discount.id,
  }));
  const scheduleIdempotencyKey = [
    "tenant-plan-schedule",
    stripeSubscription.id,
    getSubscriptionItem(stripeSubscription).price.id,
    priceId,
    stripeSubscription.current_period_end,
  ].join(":");
  const schedule = await stripe.subscriptionSchedules.create(
    { from_subscription: stripeSubscription.id },
    { idempotencyKey: scheduleIdempotencyKey },
  );
  const phaseStart =
    schedule.current_phase?.start_date ??
    stripeSubscription.current_period_start;
  const automaticTax = stripeSubscription.automatic_tax.enabled
    ? { automatic_tax: { enabled: true } }
    : {};

  await stripe.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: "release",
      metadata: {
        tenantId: String(subscription.tenant),
        plan,
        planVersion: String(planVersion),
        offerId,
        billingInterval,
        billingCurrency,
        priceLookupKey,
      },
      phases: [
        {
          start_date: phaseStart,
          end_date: stripeSubscription.current_period_end,
          items: currentItems,
          ...automaticTax,
          ...(discounts.length ? { discounts } : {}),
          proration_behavior: "none",
        },
        {
          start_date: stripeSubscription.current_period_end,
          iterations: 1,
          items: [{ price: priceId, quantity: 1 }],
          ...automaticTax,
          ...(discounts.length ? { discounts } : {}),
          metadata: {
            tenantId: String(subscription.tenant),
            plan,
            planVersion: String(planVersion),
            offerId,
            billingInterval,
            billingCurrency,
            priceLookupKey,
          },
          proration_behavior: "none",
        },
      ],
      proration_behavior: "none",
    },
    { idempotencyKey: `${scheduleIdempotencyKey}:configure` },
  );

  subscription.pendingChange = {
    plan,
    planVersion,
    billingInterval,
    effectiveAt: new Date(stripeSubscription.current_period_end * 1000),
  };
  subscription.stripe.scheduleId = schedule.id;
  await subscription.save();

  return {
    kind: "scheduled" as const,
    effectiveAt: subscription.pendingChange.effectiveAt,
    requiresAction: false,
    paymentUrl: null,
  };
};

export const changeTenantPlan = async ({
  subscription,
  plan,
  billingInterval,
  billingCurrency,
}: {
  subscription: TenantSubscriptionDocument;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  billingCurrency?: PlatformBillingCurrency;
}) => {
  const context = await buildChangeContext({
    subscription,
    plan,
    billingInterval,
    billingCurrency,
  });

  if (
    context.timing === "period_end" &&
    context.stripeSubscription.status !== "trialing"
  ) {
    return schedulePlanChange({
      subscription,
      stripeSubscription: context.stripeSubscription,
      plan,
      billingInterval,
      priceId: context.priceId,
      planVersion: context.planVersion,
      offerId: context.offerId,
      billingCurrency: context.billingCurrency,
      priceLookupKey: context.priceLookupKey,
    });
  }

  const stripeSubscription = await releaseSubscriptionSchedule(
    context.stripeSubscription,
  );
  const currentItem = getSubscriptionItem(stripeSubscription);
  const isTrialing = stripeSubscription.status === "trialing";
  const updated = await getTenantBillingStripe().subscriptions.update(
    stripeSubscription.id,
    {
      items: [
        {
          id: currentItem.id,
          price: context.priceId,
          quantity: currentItem.quantity ?? 1,
        },
      ],
      metadata: {
        tenantId: String(subscription.tenant),
        plan,
        planVersion: String(context.planVersion),
        offerId: context.offerId,
        billingInterval,
        billingCurrency: context.billingCurrency,
        priceLookupKey: context.priceLookupKey,
      },
      proration_behavior: isTrialing ? "none" : "always_invoice",
      ...(isTrialing ? {} : { payment_behavior: "pending_if_incomplete" }),
      expand: [
        "latest_invoice.payment_intent",
        "items.data.price.currency_options",
        "items.data.price.product",
      ],
    },
    {
      idempotencyKey: [
        "tenant-plan-change",
        stripeSubscription.id,
        currentItem.price.id,
        context.priceId,
        context.offerId,
        stripeSubscription.current_period_start,
      ].join(":"),
    },
  );

  const invoice = getExpandedInvoice(updated.latest_invoice);
  const requiresAction = Boolean(updated.pending_update);

  if (requiresAction) {
    subscription.pendingChange = {
      plan,
      planVersion: context.planVersion,
      billingInterval,
      effectiveAt: new Date(),
    };
    await subscription.save();
  } else {
    await syncStripeSubscriptionSnapshot({ stripeSubscription: updated });
  }

  return {
    kind: isTrialing ? ("trial_selection" as const) : ("updated" as const),
    effectiveAt: isTrialing
      ? updated.trial_end
        ? new Date(updated.trial_end * 1000)
        : null
      : new Date(),
    requiresAction,
    paymentUrl: requiresAction ? (invoice?.hosted_invoice_url ?? null) : null,
  };
};

export const cancelTenantSubscription = async ({
  subscription,
  feedback,
  comment,
}: {
  subscription: TenantSubscriptionDocument;
  feedback?: Stripe.SubscriptionUpdateParams.CancellationDetails.Feedback;
  comment?: string;
}) => {
  if (!subscription.stripe?.subscriptionId) {
    if (subscription.status !== TENANT_SUBSCRIPTION_STATUS.TRIALING) {
      conflict("There is no active subscription to cancel.");
    }

    const now = new Date();
    subscription.status = TENANT_SUBSCRIPTION_STATUS.CANCELED;
    subscription.cancelAtPeriodEnd = false;
    subscription.canceledAt = now;
    subscription.endedAt = now;
    subscription.pendingChange = undefined;
    await subscription.save();

    return { cancelAtPeriodEnd: false, endsAt: now };
  }

  let stripeSubscription = await getStripeSubscription(subscription);
  stripeSubscription = await releaseSubscriptionSchedule(stripeSubscription);
  const updated = await getTenantBillingStripe().subscriptions.update(
    stripeSubscription.id,
    {
      cancel_at_period_end: true,
      ...(feedback || comment
        ? {
            cancellation_details: {
              ...(feedback ? { feedback } : {}),
              ...(comment ? { comment } : {}),
            },
          }
        : {}),
      expand: ["items.data.price.currency_options", "items.data.price.product"],
    },
  );

  await syncStripeSubscriptionSnapshot({ stripeSubscription: updated });
  subscription.pendingChange = undefined;
  subscription.stripe.scheduleId = undefined;
  await subscription.save();

  return {
    cancelAtPeriodEnd: updated.cancel_at_period_end,
    endsAt: new Date(updated.current_period_end * 1000),
  };
};

export const resumeTenantSubscription = async (
  subscription: TenantSubscriptionDocument,
) => {
  const stripeSubscription = await getStripeSubscription(subscription);

  if (!stripeSubscription.cancel_at_period_end) {
    return {
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
    };
  }

  const updated = await getTenantBillingStripe().subscriptions.update(
    stripeSubscription.id,
    {
      cancel_at_period_end: false,
      expand: ["items.data.price.currency_options", "items.data.price.product"],
    },
  );

  await syncStripeSubscriptionSnapshot({ stripeSubscription: updated });

  return {
    cancelAtPeriodEnd: updated.cancel_at_period_end,
    currentPeriodEnd: new Date(updated.current_period_end * 1000),
  };
};

export const createTenantPortalSession = async ({
  subscription,
  tenantSlug,
  locale,
  flow,
}: {
  subscription: TenantSubscriptionDocument;
  tenantSlug: string;
  locale: string;
  flow: "home" | "payment_method_update";
}) => {
  const customerId = subscription.stripe?.customerId;

  if (!customerId) {
    conflict("Add a payment method by choosing a plan first.");
  }

  const stripe = getTenantBillingStripe();
  const configuration = await resolveTenantBillingPortalConfigurationId(stripe);
  const returnUrl = getTenantBillingUrl({ tenantSlug, locale });
  const paymentMethodReturnUrl = new URL(returnUrl);
  paymentMethodReturnUrl.searchParams.set("portal", "payment_method_updated");
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    configuration,
    locale: locale === "cs" ? "cs" : "en",
    return_url: returnUrl,
    ...(flow === "payment_method_update"
      ? {
          flow_data: {
            type: "payment_method_update" as const,
            after_completion: {
              type: "redirect" as const,
              redirect: {
                return_url: paymentMethodReturnUrl.toString(),
              },
            },
          },
        }
      : {}),
  });

  logger.info(
    {
      tenantId: String(subscription.tenant),
      tenantSlug,
      stripeCustomerId: customerId,
      stripePortalSessionId: session.id,
      flow,
    },
    "Stripe Billing Portal session created.",
  );

  return session.url;
};

export type TenantPlanChangeTiming = PlanChangeTiming;
