import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import {
  PLATFORM_BILLING_CURRENCIES,
  type PlatformBillingCurrency,
} from "@/shared/money/currency.js";

import { BILLING_INTERVAL } from "./tenant-subscription.constants.js";
import type { BillingInterval } from "./tenant-subscription.types.js";
import {
  INTERNATIONAL_OFFER_ID,
  INTERNATIONAL_PRICE_AMOUNTS_MINOR,
} from "./tenant-subscription.prices.js";

export const FOUNDING_OFFER_ID = "founding_2026_v1" as const;
export const FOUNDING_ENTITLEMENT_VERSION = 2 as const;
export const PLAN_V3_OFFER_ID = "plans_v3_2026_v1" as const;
export const PLAN_V3_ENTITLEMENT_VERSION = 3 as const;
export const CURRENT_COMMERCIAL_OFFER_ID = INTERNATIONAL_OFFER_ID;
const HISTORICAL_SALE_CURRENCIES = ["CZK", "EUR"] as const;
export const NEW_SALE_CURRENCIES = PLATFORM_BILLING_CURRENCIES;

export type NewSaleCurrency = (typeof NEW_SALE_CURRENCIES)[number];
export type CommercialPriceType = "fixed" | "from" | "custom";
export type CommercialAmountMap = Readonly<
  Partial<Record<NewSaleCurrency, number>>
>;

export type CommercialRecurringPrice = {
  type: CommercialPriceType;
  amounts: CommercialAmountMap | null;
};

export type CommercialPlanOffer = {
  plan: TenantPlan;
  displayName: string;
  positioning?: string;
  entitlementVersion: number;
  selfServe: boolean;
  recommended: boolean;
  saleMode: "self_serve" | "sales_assisted";
  recurring: Readonly<Record<BillingInterval, CommercialRecurringPrice>>;
  onboarding: {
    type: "from";
    amounts: CommercialAmountMap;
  } | null;
};

export type CommercialOffer = {
  id: string;
  active: boolean;
  founding: boolean;
  taxBehavior: "exclusive";
  defaultCurrency: NewSaleCurrency;
  newSaleCurrencies: readonly NewSaleCurrency[];
  annualSavingsMonths: number;
  plans: Readonly<Record<TenantPlan, CommercialPlanOffer>>;
};

export type CommercialOfferCatalog = Readonly<Record<string, CommercialOffer>>;

export type CommercialPriceSpec = {
  offerId: string;
  entitlementVersion: number;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  displayName: string;
  defaultCurrency: NewSaleCurrency;
  amounts: CommercialAmountMap;
  taxBehavior: "exclusive";
  lookupKey: string;
};

const amounts = (CZK: number, EUR: number): CommercialAmountMap => ({
  CZK,
  EUR,
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }

  return value;
};

/**
 * Code-owned new-sale contract. Amounts are Stripe minor units (halers/cents),
 * tax exclusive. Commercial offers are intentionally versioned independently
 * from plan entitlements so founding customers can be grandfathered safely.
 */
const COMMERCIAL_OFFER_DEFINITION = {
  id: FOUNDING_OFFER_ID,
  active: true,
  founding: true,
  taxBehavior: "exclusive",
  defaultCurrency: "CZK",
  newSaleCurrencies: HISTORICAL_SALE_CURRENCIES,
  annualSavingsMonths: 2,
  plans: {
    [TENANT_PLAN.STARTER]: {
      plan: TENANT_PLAN.STARTER,
      displayName: "Starter",
      entitlementVersion: FOUNDING_ENTITLEMENT_VERSION,
      selfServe: true,
      recommended: false,
      saleMode: "self_serve",
      recurring: {
        [BILLING_INTERVAL.MONTHLY]: {
          type: "fixed",
          amounts: amounts(99_000, 3_900),
        },
        [BILLING_INTERVAL.YEARLY]: {
          type: "fixed",
          amounts: amounts(990_000, 39_000),
        },
      },
      onboarding: null,
    },
    [TENANT_PLAN.PROFESSIONAL]: {
      plan: TENANT_PLAN.PROFESSIONAL,
      displayName: "Professional",
      entitlementVersion: FOUNDING_ENTITLEMENT_VERSION,
      selfServe: true,
      recommended: true,
      saleMode: "self_serve",
      recurring: {
        [BILLING_INTERVAL.MONTHLY]: {
          type: "fixed",
          amounts: amounts(199_000, 7_900),
        },
        [BILLING_INTERVAL.YEARLY]: {
          type: "fixed",
          amounts: amounts(1_990_000, 79_000),
        },
      },
      onboarding: null,
    },
    [TENANT_PLAN.STUDIO_PLUS]: {
      plan: TENANT_PLAN.STUDIO_PLUS,
      displayName: "Studio Plus",
      entitlementVersion: FOUNDING_ENTITLEMENT_VERSION,
      selfServe: true,
      recommended: false,
      saleMode: "self_serve",
      recurring: {
        [BILLING_INTERVAL.MONTHLY]: {
          type: "fixed",
          amounts: amounts(429_000, 16_900),
        },
        [BILLING_INTERVAL.YEARLY]: {
          type: "fixed",
          amounts: amounts(4_290_000, 169_000),
        },
      },
      onboarding: null,
    },
    [TENANT_PLAN.ENTERPRISE]: {
      plan: TENANT_PLAN.ENTERPRISE,
      displayName: "Enterprise",
      entitlementVersion: FOUNDING_ENTITLEMENT_VERSION,
      selfServe: false,
      recommended: false,
      saleMode: "sales_assisted",
      recurring: {
        [BILLING_INTERVAL.MONTHLY]: {
          type: "from",
          amounts: amounts(799_000, 31_900),
        },
        [BILLING_INTERVAL.YEARLY]: {
          type: "custom",
          amounts: null,
        },
      },
      onboarding: {
        type: "from",
        amounts: amounts(2_000_000, 79_000),
      },
    },
  },
} as const satisfies CommercialOffer;

/**
 * Plan V3 keeps the founding price points while publishing the revised plan
 * boundaries and customer-facing positioning from the V3 product contract.
 * It is a distinct offer so V2 Stripe prices and entitlements stay immutable.
 */
const PLAN_V3_COMMERCIAL_OFFER_DEFINITION = {
  ...COMMERCIAL_OFFER_DEFINITION,
  id: PLAN_V3_OFFER_ID,
  founding: false,
  plans: {
    [TENANT_PLAN.STARTER]: {
      ...COMMERCIAL_OFFER_DEFINITION.plans.starter,
      displayName: "Starter",
      positioning: "Run your courses.",
      entitlementVersion: PLAN_V3_ENTITLEMENT_VERSION,
    },
    [TENANT_PLAN.PROFESSIONAL]: {
      ...COMMERCIAL_OFFER_DEFINITION.plans.professional,
      displayName: "Professional",
      positioning: "Run your studio.",
      entitlementVersion: PLAN_V3_ENTITLEMENT_VERSION,
    },
    [TENANT_PLAN.STUDIO_PLUS]: {
      ...COMMERCIAL_OFFER_DEFINITION.plans.studio_plus,
      displayName: "Studio Plus",
      positioning: "Automate and scale your studio.",
      entitlementVersion: PLAN_V3_ENTITLEMENT_VERSION,
    },
    [TENANT_PLAN.ENTERPRISE]: {
      ...COMMERCIAL_OFFER_DEFINITION.plans.enterprise,
      displayName: "Enterprise",
      positioning: "Run your organization.",
      entitlementVersion: PLAN_V3_ENTITLEMENT_VERSION,
      onboarding: null,
    },
  },
} as const satisfies CommercialOffer;

const configuredAmounts = (
  values: Readonly<Record<PlatformBillingCurrency, number | null>> | null,
): CommercialAmountMap | null => {
  if (!values) return null;

  return Object.fromEntries(
    Object.entries(values).flatMap(([currency, amount]) => {
      if (amount === null) return [];
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(
          `Invalid configured ${currency} subscription price: ${amount}.`,
        );
      }
      return [[currency, amount]];
    }),
  );
};

const internationalPlans = Object.fromEntries(
  Object.values(PLAN_V3_COMMERCIAL_OFFER_DEFINITION.plans).map((plan) => [
    plan.plan,
    {
      ...plan,
      recurring: Object.fromEntries(
        Object.values(BILLING_INTERVAL).map((interval) => [
          interval,
          {
            ...plan.recurring[interval],
            amounts: configuredAmounts(
              INTERNATIONAL_PRICE_AMOUNTS_MINOR[plan.plan][interval],
            ),
          },
        ]),
      ),
    },
  ]),
) as CommercialOffer["plans"];

const INTERNATIONAL_COMMERCIAL_OFFER_DEFINITION: CommercialOffer = {
  ...PLAN_V3_COMMERCIAL_OFFER_DEFINITION,
  id: INTERNATIONAL_OFFER_ID,
  // Stripe's base currency is independent of a visitor's suggested currency.
  // Keep CZK until USD amounts are approved; explicit checkout uses its choice.
  defaultCurrency: "CZK",
  newSaleCurrencies: PLATFORM_BILLING_CURRENCIES.filter((currency) =>
    Object.values(internationalPlans)
      .filter((plan) => plan.selfServe)
      .every((plan) =>
        Object.values(BILLING_INTERVAL).every(
          (interval) => plan.recurring[interval].amounts?.[currency] !== undefined,
        ),
      ),
  ),
  plans: internationalPlans,
};

/**
 * Immutable commercial history. Add a new entry and advance
 * CURRENT_COMMERCIAL_OFFER_ID when new-sale pricing changes; never mutate the
 * founding offer, because existing Stripe prices remain tied to it.
 */
export const COMMERCIAL_OFFER_CATALOG = deepFreeze({
  [FOUNDING_OFFER_ID]: COMMERCIAL_OFFER_DEFINITION,
  [PLAN_V3_OFFER_ID]: PLAN_V3_COMMERCIAL_OFFER_DEFINITION,
  [INTERNATIONAL_OFFER_ID]: INTERNATIONAL_COMMERCIAL_OFFER_DEFINITION,
}) satisfies CommercialOfferCatalog;

export type CommercialOfferId = keyof typeof COMMERCIAL_OFFER_CATALOG;

const getOfferDefinition = (
  offerCatalog: CommercialOfferCatalog,
  offerId: string,
): CommercialOffer | null => offerCatalog[offerId] ?? null;

const getCurrentOfferDefinition = (): CommercialOffer => {
  const offer = getOfferDefinition(
    COMMERCIAL_OFFER_CATALOG,
    CURRENT_COMMERCIAL_OFFER_ID,
  );

  if (!offer) {
    throw new Error(
      `Current commercial offer ${CURRENT_COMMERCIAL_OFFER_ID} is missing.`,
    );
  }

  return offer;
};

export const isNewSaleCurrency = (
  currency: string,
): currency is NewSaleCurrency =>
  getCurrentOfferDefinition().newSaleCurrencies.includes(
    currency.toUpperCase() as NewSaleCurrency,
  );

/** Every Price is checked against its own offer, never the current global list. */
export const getCommercialPriceCurrencies = (
  spec: Pick<CommercialPriceSpec, "amounts">,
): PlatformBillingCurrency[] =>
  PLATFORM_BILLING_CURRENCIES.filter(
    (currency) => spec.amounts[currency] !== undefined,
  );

export const getRequiredCommercialPriceAmount = (
  spec: Pick<CommercialPriceSpec, "amounts">,
  currency: PlatformBillingCurrency,
): number => {
  const amount = spec.amounts[currency];
  if (amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(
      `Missing or invalid configured ${currency} subscription price.`,
    );
  }
  return amount;
};

export const getCurrentCommercialOffer = (): CommercialOffer =>
  structuredClone(getCurrentOfferDefinition());

export const getCommercialOffer = (offerId: string): CommercialOffer | null => {
  const offer = getOfferDefinition(COMMERCIAL_OFFER_CATALOG, offerId);
  return offer ? structuredClone(offer) : null;
};

export const getCommercialOffers = (): CommercialOffer[] =>
  Object.values(COMMERCIAL_OFFER_CATALOG).map((offer) =>
    structuredClone(offer),
  );

export const getCommercialPlanOffer = (
  plan: TenantPlan,
  offerId: string = CURRENT_COMMERCIAL_OFFER_ID,
): CommercialPlanOffer | null => {
  const offer = getOfferDefinition(COMMERCIAL_OFFER_CATALOG, offerId);
  return offer ? structuredClone(offer.plans[plan]) : null;
};

export const getCommercialAmount = (
  plan: TenantPlan,
  billingInterval: BillingInterval,
  currency: NewSaleCurrency,
): number | null =>
  getCurrentOfferDefinition().plans[plan].recurring[billingInterval].amounts?.[
    currency
  ] ?? null;

export const getCommercialStripeLookupKey = (
  plan: TenantPlan,
  billingInterval: BillingInterval,
  offerId: string = CURRENT_COMMERCIAL_OFFER_ID,
): string => `shario_${offerId}_${plan}_${billingInterval}`;

const buildCommercialPriceSpec = (
  offer: CommercialOffer,
  plan: TenantPlan,
  billingInterval: BillingInterval,
  planVersion: number,
): CommercialPriceSpec | null => {
  const planOffer = offer.plans[plan];
  const recurring = planOffer.recurring[billingInterval];

  if (
    !planOffer.selfServe ||
    planOffer.entitlementVersion !== planVersion ||
    recurring.type !== "fixed" ||
    !recurring.amounts
  ) {
    return null;
  }

  const requiredCurrencies = new Set([
    offer.defaultCurrency,
    ...offer.newSaleCurrencies,
  ]);
  for (const currency of requiredCurrencies) {
    getRequiredCommercialPriceAmount({ amounts: recurring.amounts }, currency);
  }

  return {
    offerId: offer.id,
    entitlementVersion: planOffer.entitlementVersion,
    plan,
    billingInterval,
    displayName: planOffer.displayName,
    defaultCurrency: offer.defaultCurrency,
    amounts: structuredClone(recurring.amounts),
    taxBehavior: offer.taxBehavior,
    lookupKey: getCommercialStripeLookupKey(plan, billingInterval, offer.id),
  };
};

/**
 * Enumerates every immutable offer that can identify a historical Stripe
 * Price. This is deliberately separate from the current-offer helper used for
 * new checkout and display.
 */
export const getCommercialPriceSpecsFromCatalog = ({
  offerCatalog,
  plan,
  billingInterval,
  planVersion,
}: {
  offerCatalog: CommercialOfferCatalog;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  planVersion: number;
}): CommercialPriceSpec[] =>
  Object.values(offerCatalog).flatMap((offer) => {
    const spec = buildCommercialPriceSpec(
      offer,
      plan,
      billingInterval,
      planVersion,
    );
    return spec ? [spec] : [];
  });

export const getCommercialPriceSpecs = (
  plan: TenantPlan,
  billingInterval: BillingInterval,
  planVersion: number,
): CommercialPriceSpec[] =>
  getCommercialPriceSpecsFromCatalog({
    offerCatalog: COMMERCIAL_OFFER_CATALOG,
    plan,
    billingInterval,
    planVersion,
  });

export const getCommercialPriceSpecForOffer = (
  offerId: string,
  plan: TenantPlan,
  billingInterval: BillingInterval,
  planVersion: number,
): CommercialPriceSpec | null => {
  const offer = getOfferDefinition(COMMERCIAL_OFFER_CATALOG, offerId);
  return offer
    ? buildCommercialPriceSpec(offer, plan, billingInterval, planVersion)
    : null;
};

/**
 * Resolves the implicit offer used by compatibility callers that predate
 * offer IDs. The active current offer wins when it targets the requested
 * entitlement version. Otherwise exactly one historical offer must match;
 * silently selecting between multiple historical offers would attach the
 * wrong immutable Stripe price.
 */
export const getCommercialPriceSpecFromCatalog = ({
  offerCatalog,
  currentOfferId,
  plan,
  billingInterval,
  planVersion,
}: {
  offerCatalog: CommercialOfferCatalog;
  currentOfferId: string;
  plan: TenantPlan;
  billingInterval: BillingInterval;
  planVersion: number;
}): CommercialPriceSpec | null => {
  const currentOffer = getOfferDefinition(offerCatalog, currentOfferId);

  if (!currentOffer) {
    throw new Error(`Current commercial offer ${currentOfferId} is missing.`);
  }

  if (currentOffer.active) {
    const currentSpec = buildCommercialPriceSpec(
      currentOffer,
      plan,
      billingInterval,
      planVersion,
    );
    if (currentSpec) return currentSpec;
  }

  const historicalSpecs = getCommercialPriceSpecsFromCatalog({
    offerCatalog,
    plan,
    billingInterval,
    planVersion,
  }).filter(({ offerId }) => offerId !== currentOfferId);

  if (historicalSpecs.length === 1) return historicalSpecs[0];
  if (historicalSpecs.length === 0) return null;

  const matchingOfferIds = historicalSpecs
    .map(({ offerId }) => offerId)
    .sort()
    .join(", ");
  throw new Error(
    `Commercial price resolution is ambiguous for ${plan} V${planVersion} ${billingInterval}: ${matchingOfferIds}.`,
  );
};

/** Returns a provisionable fixed price, never a sales-assisted quote. */
export const getCommercialPriceSpec = (
  plan: TenantPlan,
  billingInterval: BillingInterval,
  planVersion: number,
): CommercialPriceSpec | null =>
  getCommercialPriceSpecFromCatalog({
    offerCatalog: COMMERCIAL_OFFER_CATALOG,
    currentOfferId: CURRENT_COMMERCIAL_OFFER_ID,
    plan,
    billingInterval,
    planVersion,
  });
