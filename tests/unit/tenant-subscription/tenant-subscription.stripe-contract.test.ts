import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import {
  BILLING_INTERVAL,
  TENANT_SUBSCRIPTION_STATUS,
} from "@/modules/tenant-subscription/tenant-subscription.constants.js";
import { getTenantCheckoutTrialPolicy } from "@/modules/tenant-subscription/tenant-subscription.checkout-policy.js";
import {
  getCommercialPriceSpec,
  getCommercialPriceSpecForOffer,
  PLAN_V3_OFFER_ID,
} from "@/modules/tenant-subscription/tenant-subscription.commercial.js";
import { PLATFORM_BILLING_CURRENCIES } from "@/shared/money/currency.js";
import {
  assertStripeSubscriptionContract,
  buildStripePriceMetadata,
  buildStripePriceCreateParams,
  buildStripeProductMetadata,
  getTenantBillingAutomaticTaxIssue,
  inspectStripePriceContract,
} from "@/modules/tenant-subscription/tenant-subscription.stripe-contract.js";

const spec = getCommercialPriceSpec(
  TENANT_PLAN.STARTER,
  BILLING_INTERVAL.MONTHLY,
  2,
);

if (!spec) {
  throw new Error("The founding Starter monthly v2 Price contract is missing.");
}

const product = {
  id: "prod_starter",
  object: "product",
  active: true,
  livemode: false,
  name: `shario.io ${spec.displayName}`,
  metadata: buildStripeProductMetadata(spec),
} as unknown as Stripe.Product;

const validPrice = {
  id: "price_starter_monthly",
  object: "price",
  active: true,
  livemode: false,
  lookup_key: spec.lookupKey,
  type: "recurring",
  billing_scheme: "per_unit",
  recurring: {
    interval: "month",
    interval_count: 1,
    usage_type: "licensed",
  },
  tax_behavior: spec.taxBehavior,
  currency: "czk",
  unit_amount: spec.amounts.CZK,
  currency_options: {
    eur: {
      unit_amount: spec.amounts.EUR,
      tax_behavior: spec.taxBehavior,
    },
  },
  metadata: buildStripePriceMetadata(spec),
  product,
} as unknown as Stripe.Price;

const subscriptionWith = ({
  price = validPrice,
  metadata = {},
}: {
  price?: Stripe.Price;
  metadata?: Record<string, string>;
} = {}) =>
  ({
    id: "sub_starter",
    object: "subscription",
    metadata: {
      plan: spec.plan,
      planVersion: String(spec.entitlementVersion),
      offerId: spec.offerId,
      billingInterval: spec.billingInterval,
      priceLookupKey: spec.lookupKey,
      ...metadata,
    },
    items: {
      object: "list",
      data: [{ id: "si_starter", quantity: 1, price }],
      has_more: false,
      url: "/v1/subscription_items",
    },
  }) as unknown as Stripe.Subscription;

describe("tenant subscription Stripe contract", () => {
  it("retains V3's own two-currency contract after the current offer expands", () => {
    const historical = getCommercialPriceSpecForOffer(PLAN_V3_OFFER_ID, "starter", "monthly", 3)!;
    const price = {
      ...validPrice,
      lookup_key: historical.lookupKey,
      metadata: buildStripePriceMetadata(historical),
      product: { ...product, metadata: buildStripeProductMetadata(historical) },
    } as Stripe.Price;
    expect(inspectStripePriceContract({ price, spec: historical, mode: "test" })).toEqual([]);
    expect(assertStripeSubscriptionContract({
      stripeSubscription: subscriptionWith({ price, metadata: {
        planVersion: "3", offerId: historical.offerId, priceLookupKey: historical.lookupKey,
      } }),
      mode: "test",
    }).offerId).toBe(PLAN_V3_OFFER_ID);
  });

  it("provisions and validates every currency in an offer, including a missing PLN option", () => {
    // Synthetic approved amounts exercise support without setting production prices.
    const expandedSpec = {
      ...spec,
      amounts: Object.fromEntries(PLATFORM_BILLING_CURRENCIES.map((currency, index) => [currency, (index + 1) * 100])),
    };
    const params = buildStripePriceCreateParams(expandedSpec, product.id);
    expect(Object.keys(params.currency_options ?? {})).toHaveLength(10);
    const price = { ...validPrice, ...params, product } as unknown as Stripe.Price;
    expect(inspectStripePriceContract({ price, spec: expandedSpec, mode: "test" })).toEqual([]);
    delete price.currency_options!.pln;
    expect(inspectStripePriceContract({ price, spec: expandedSpec, mode: "test" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "price.amount.PLN" })]),
    );
    expect(() => buildStripePriceCreateParams({ ...expandedSpec, amounts: {} }, product.id)).toThrow(/CZK subscription price/);
  });

  it("accepts the canonical founding Price in test mode", () => {
    expect(
      inspectStripePriceContract({ price: validPrice, spec, mode: "test" }),
    ).toEqual([]);

    expect(
      assertStripeSubscriptionContract({
        stripeSubscription: subscriptionWith(),
        mode: "test",
      }),
    ).toEqual({
      plan: TENANT_PLAN.STARTER,
      planVersion: 2,
      offerId: spec.offerId,
      billingInterval: BILLING_INTERVAL.MONTHLY,
    });
  });

  it.each([
    ["amount", { unit_amount: spec.amounts.CZK + 1 }],
    ["interval", { recurring: { ...validPrice.recurring, interval: "year" } }],
    ["tax", { tax_behavior: "inclusive" }],
    ["lookup key", { lookup_key: "shario_wrong" }],
    ["livemode", { livemode: true }],
  ])("rejects %s drift", (_label, drift) => {
    const price = { ...validPrice, ...drift } as Stripe.Price;

    expect(
      inspectStripePriceContract({ price, spec, mode: "test" }),
    ).not.toEqual([]);
  });

  it("fails closed when subscription metadata disagrees with the Price", () => {
    expect(() =>
      assertStripeSubscriptionContract({
        stripeSubscription: subscriptionWith({
          metadata: { plan: TENANT_PLAN.PROFESSIONAL },
        }),
        mode: "test",
      }),
    ).toThrow(/metadata plan/);
  });

  it("fails closed for a Price outside the configured catalogue", () => {
    const unknownPrice = {
      ...validPrice,
      id: "price_unknown",
      lookup_key: "shario_unknown_monthly",
    } as Stripe.Price;

    expect(() =>
      assertStripeSubscriptionContract({
        stripeSubscription: subscriptionWith({ price: unknownPrice }),
        mode: "test",
      }),
    ).toThrow(/not configured/);
  });

  it("accepts absent V1 metadata but rejects every present mismatch", () => {
    const legacyPrice = {
      ...validPrice,
      id: "price_starter_monthly_v1",
      lookup_key: "shario_starter_monthly_v1",
      metadata: {},
      product: "prod_legacy_starter",
    } as Stripe.Price;
    const legacySubscription = {
      id: "sub_starter_v1",
      object: "subscription",
      metadata: {},
      items: {
        object: "list",
        data: [{ id: "si_starter_v1", quantity: 1, price: legacyPrice }],
        has_more: false,
        url: "/v1/subscription_items",
      },
    } as unknown as Stripe.Subscription;

    expect(
      assertStripeSubscriptionContract({
        stripeSubscription: legacySubscription,
        mode: "test",
      }),
    ).toEqual({
      plan: TENANT_PLAN.STARTER,
      planVersion: 1,
      offerId: null,
      billingInterval: BILLING_INTERVAL.MONTHLY,
    });

    for (const metadata of [
      { plan: TENANT_PLAN.PROFESSIONAL },
      { planVersion: "2" },
      { billingInterval: BILLING_INTERVAL.YEARLY },
      { priceLookupKey: "shario_wrong" },
      { offerId: "unexpected_offer" },
    ]) {
      expect(() =>
        assertStripeSubscriptionContract({
          stripeSubscription: {
            ...legacySubscription,
            metadata,
          } as Stripe.Subscription,
          mode: "test",
        }),
      ).toThrow(/metadata/);
    }
  });
});

describe("tenant Checkout production policy", () => {
  const now = new Date("2026-08-10T10:00:00.000Z");

  it("preserves a local trial only when more than 48 hours remain", () => {
    expect(
      getTenantCheckoutTrialPolicy({
        status: TENANT_SUBSCRIPTION_STATUS.TRIALING,
        trialEndsAt: new Date("2026-08-12T10:00:01.000Z"),
        now,
      }),
    ).toEqual({
      kind: "preserve_trial",
      allowed: true,
      trialEnd: Math.floor(
        new Date("2026-08-12T10:00:01.000Z").getTime() / 1000,
      ),
    });
  });

  it.each([
    null,
    new Date("2026-08-12T10:00:00.000Z"),
    new Date("2026-08-11T10:00:00.000Z"),
    new Date("2026-08-10T10:00:00.001Z"),
    new Date("invalid"),
  ])("blocks Checkout only while the final trial window remains or the end is unknown", (trialEndsAt) => {
    expect(
      getTenantCheckoutTrialPolicy({
        status: TENANT_SUBSCRIPTION_STATUS.TRIALING,
        trialEndsAt,
        now,
      }),
    ).toEqual({
      kind: "blocked_final_window",
      allowed: false,
      trialEnd: null,
    });
  });

  it.each([
    new Date("2026-08-10T10:00:00.000Z"),
    new Date("2026-08-10T09:59:59.000Z"),
  ])("allows paid Checkout after expiry without waiting for reconciliation", (trialEndsAt) => {
    expect(getTenantCheckoutTrialPolicy({
      status: TENANT_SUBSCRIPTION_STATUS.TRIALING, trialEndsAt, now,
    })).toEqual({ kind: "without_trial", allowed: true, trialEnd: null });
  });

  it("does not add a trial after the lifecycle leaves trialing", () => {
    expect(
      getTenantCheckoutTrialPolicy({
        status: TENANT_SUBSCRIPTION_STATUS.EXPIRED,
        trialEndsAt: new Date("2026-08-20T10:00:00.000Z"),
        now,
      }),
    ).toEqual({ kind: "without_trial", allowed: true, trialEnd: null });
  });

  it("requires automatic tax for live readiness but not test mode", () => {
    expect(
      getTenantBillingAutomaticTaxIssue({
        mode: "live",
        automaticTaxEnabled: false,
      }),
    ).toMatch(/requires STRIPE_AUTOMATIC_TAX_ENABLED=true/);
    expect(
      getTenantBillingAutomaticTaxIssue({
        mode: "live",
        automaticTaxEnabled: true,
      }),
    ).toBeNull();
    expect(
      getTenantBillingAutomaticTaxIssue({
        mode: "test",
        automaticTaxEnabled: false,
      }),
    ).toBeNull();
  });
});
