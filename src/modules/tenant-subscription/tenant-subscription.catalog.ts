import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import {
  getCurrentPlanVersion,
  getKnownPlanVersions,
  isKnownPlanVersion,
  getPlanConfig,
} from "@/modules/tenants/tenant.plan.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import {
  DEFAULT_PLATFORM_BILLING_CURRENCY,
  PLATFORM_BILLING_CURRENCIES,
} from "@/shared/money/currency.js";

import {
  COMMERCIAL_OFFER_CATALOG,
  CURRENT_COMMERCIAL_OFFER_ID,
  getCurrentCommercialOffer,
  getCommercialPriceSpecsFromCatalog,
  getCommercialStripeLookupKey,
  type CommercialAmountMap,
  type CommercialOfferCatalog,
  type CommercialPriceSpec,
} from "./tenant-subscription.commercial.js";
import { BILLING_INTERVAL } from "./tenant-subscription.constants.js";
import type { BillingInterval } from "./tenant-subscription.types.js";

export const SELF_SERVE_PLANS: readonly TenantPlan[] = [
  TENANT_PLAN.STARTER,
  TENANT_PLAN.PROFESSIONAL,
  TENANT_PLAN.STUDIO_PLUS,
];

export const PLAN_ORDER: readonly TenantPlan[] = [
  ...SELF_SERVE_PLANS,
  TENANT_PLAN.ENTERPRISE,
];

const PRICE_ENV_KEYS: Record<
  Exclude<TenantPlan, "enterprise">,
  Record<BillingInterval, string>
> = {
  [TENANT_PLAN.STARTER]: {
    [BILLING_INTERVAL.MONTHLY]: "STRIPE_STARTER_MONTHLY_PRICE_ID",
    [BILLING_INTERVAL.YEARLY]: "STRIPE_STARTER_YEARLY_PRICE_ID",
  },
  [TENANT_PLAN.PROFESSIONAL]: {
    [BILLING_INTERVAL.MONTHLY]: "STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID",
    [BILLING_INTERVAL.YEARLY]: "STRIPE_PROFESSIONAL_YEARLY_PRICE_ID",
  },
  [TENANT_PLAN.STUDIO_PLUS]: {
    [BILLING_INTERVAL.MONTHLY]: "STRIPE_STUDIO_PLUS_MONTHLY_PRICE_ID",
    [BILLING_INTERVAL.YEARLY]: "STRIPE_STUDIO_PLUS_YEARLY_PRICE_ID",
  },
};

export type StripePlanPriceReference = {
  plan: TenantPlan;
  planVersion: number;
  offerId: string | null;
  billingInterval: BillingInterval;
  priceId: string | null;
  lookupKey: string;
  expectedAmounts: CommercialAmountMap | null;
};

/** All currencies retained for already-existing Stripe subscriptions. */
export const PLATFORM_SUBSCRIPTION_CURRENCIES = PLATFORM_BILLING_CURRENCIES;

/** Currencies accepted for new subscriptions to the current offer. */
export const PLATFORM_SUBSCRIPTION_NEW_SALE_CURRENCIES =
  getCurrentCommercialOffer().newSaleCurrencies;

export const PLATFORM_SUBSCRIPTION_FALLBACK_CURRENCY =
  DEFAULT_PLATFORM_BILLING_CURRENCY;

export const isSelfServePlan = (plan: TenantPlan): boolean => {
  return SELF_SERVE_PLANS.includes(plan);
};

export const getStripePriceId = (
  plan: TenantPlan,
  interval: BillingInterval,
): string | null => {
  if (!isSelfServePlan(plan)) return null;

  const envKey =
    PRICE_ENV_KEYS[plan as Exclude<TenantPlan, "enterprise">][interval];
  return process.env[envKey]?.trim() || null;
};

const getLegacyStripePriceLookupKey = (
  plan: TenantPlan,
  interval: BillingInterval,
  planVersion: number,
): string => `shario_${plan}_${interval}_v${planVersion}`;

export const getStripePriceLookupKey = (
  plan: TenantPlan,
  interval: BillingInterval,
  planVersion: number = getCurrentPlanVersion(plan),
): string => {
  const specs = getCommercialPriceSpecsFromCatalog({
    offerCatalog: COMMERCIAL_OFFER_CATALOG,
    plan,
    billingInterval: interval,
    planVersion,
  });
  const preferredSpec =
    specs.find(({ offerId }) => offerId === CURRENT_COMMERCIAL_OFFER_ID) ??
    specs[0];

  return (
    preferredSpec?.lookupKey ??
    getLegacyStripePriceLookupKey(plan, interval, planVersion)
  );
};

type StripePriceEnvironment = Readonly<Record<string, string | undefined>>;

const getEnvironmentValue = (
  environment: StripePriceEnvironment,
  key: string,
): string | null => environment[key]?.trim() || null;

const getOfferScopedStripePriceId = (
  spec: CommercialPriceSpec,
  environment: StripePriceEnvironment,
): string | null =>
  getEnvironmentValue(
    environment,
    `STRIPE_${spec.offerId.toUpperCase()}_${spec.plan.toUpperCase()}_${spec.billingInterval.toUpperCase()}_PRICE_ID`,
  );

const getVersionedStripePriceId = (
  plan: Exclude<TenantPlan, "enterprise">,
  interval: BillingInterval,
  planVersion: number,
  environment: StripePriceEnvironment,
): string | null => {
  const envKey = `STRIPE_${plan.toUpperCase()}_${interval.toUpperCase()}_V${planVersion}_PRICE_ID`;
  const versionedPriceId = getEnvironmentValue(environment, envKey);

  if (versionedPriceId) return versionedPriceId;

  // Preserve the original six environment variables as v1 aliases.
  if (planVersion !== 1) return null;

  return getEnvironmentValue(environment, PRICE_ENV_KEYS[plan][interval]);
};

/**
 * Pure offer-aware reference builder used by production resolution and by the
 * two-offer regression test. Historical offers can share an entitlement
 * version, but their lookup keys and preferred Price IDs remain independent.
 */
export const buildStripePriceReferencesForCommercialCatalog = ({
  offerCatalog,
  plan,
  interval,
  planVersion,
  environment = process.env,
}: {
  offerCatalog: CommercialOfferCatalog;
  currentOfferId: string;
  plan: Exclude<TenantPlan, "enterprise">;
  interval: BillingInterval;
  planVersion: number;
  environment?: StripePriceEnvironment;
}): StripePlanPriceReference[] => {
  const specs = getCommercialPriceSpecsFromCatalog({
    offerCatalog,
    plan,
    billingInterval: interval,
    planVersion,
  });

  if (!specs.length) {
    return [
      {
        plan,
        planVersion,
        offerId: null,
        billingInterval: interval,
        priceId: getVersionedStripePriceId(
          plan,
          interval,
          planVersion,
          environment,
        ),
        lookupKey: getLegacyStripePriceLookupKey(plan, interval, planVersion),
        expectedAmounts: null,
      },
    ];
  }

  return specs.map((spec) => ({
    plan,
    planVersion,
    offerId: spec.offerId,
    billingInterval: interval,
    priceId:
      getOfferScopedStripePriceId(spec, environment) ??
      // A version-scoped alias belongs to the first immutable offer that used
      // that entitlement version. Advancing the current offer must not attach
      // an old Price ID to a new offer and invalidate historical webhooks.
      (spec.offerId === specs[0].offerId
        ? getVersionedStripePriceId(plan, interval, planVersion, environment)
        : null),
    lookupKey: spec.lookupKey,
    expectedAmounts: structuredClone(spec.amounts),
  }));
};

export const getStripePriceReferences = (
  plan: TenantPlan,
  interval: BillingInterval,
  planVersion: number = getCurrentPlanVersion(plan),
): StripePlanPriceReference[] => {
  if (!isSelfServePlan(plan) || !isKnownPlanVersion(plan, planVersion)) {
    return [];
  }

  return buildStripePriceReferencesForCommercialCatalog({
    offerCatalog: COMMERCIAL_OFFER_CATALOG,
    currentOfferId: CURRENT_COMMERCIAL_OFFER_ID,
    plan: plan as Exclude<TenantPlan, "enterprise">,
    interval,
    planVersion,
  });
};

/**
 * Immutable code-owned Stripe reference. V1 remains mapped to its historical
 * lookup keys; V2 and V3 resolve through their separately versioned offers.
 */
export const getStripePriceReference = (
  plan: TenantPlan,
  interval: BillingInterval,
  planVersion: number = getCurrentPlanVersion(plan),
  offerId?: string | null,
): StripePlanPriceReference | null => {
  const references = getStripePriceReferences(plan, interval, planVersion);

  if (offerId === undefined) {
    return (
      references.find(
        (reference) => reference.offerId === CURRENT_COMMERCIAL_OFFER_ID,
      ) ?? (references.length === 1 ? references[0] : null)
    );
  }

  return (
    references.find((reference) => reference.offerId === offerId) ??
    (references.length === 1 && references[0]?.offerId === null
      ? references[0]
      : null)
  );
};

export const getPlanFromStripePriceId = (
  priceId: string,
): TenantPlan | null => {
  return getPlanSelectionFromStripePriceId(priceId)?.plan ?? null;
};

export type StripePlanSelection = {
  plan: TenantPlan;
  planVersion: number;
  offerId: string | null;
  billingInterval: BillingInterval;
};

const getSelectionFromReference = (
  reference: StripePlanPriceReference,
): StripePlanSelection => ({
  plan: reference.plan,
  planVersion: reference.planVersion,
  offerId: reference.offerId,
  billingInterval: reference.billingInterval,
});

const selectionsMatch = (
  left: StripePlanSelection,
  right: StripePlanSelection,
): boolean =>
  left.plan === right.plan &&
  left.planVersion === right.planVersion &&
  left.offerId === right.offerId &&
  left.billingInterval === right.billingInterval;

export const getPlanSelectionFromStripeReferences = ({
  references,
  priceId,
  lookupKey,
}: {
  references: readonly StripePlanPriceReference[];
  priceId?: string;
  lookupKey?: string;
}): StripePlanSelection | null => {
  const matches = references.filter(
    (reference) =>
      (priceId !== undefined && reference.priceId === priceId) ||
      (lookupKey !== undefined && reference.lookupKey === lookupKey),
  );

  if (!matches.length) return null;

  const first = getSelectionFromReference(matches[0]);
  return matches
    .slice(1)
    .every((reference) =>
      selectionsMatch(first, getSelectionFromReference(reference)),
    )
    ? first
    : null;
};

const getAllStripePriceReferences = (): StripePlanPriceReference[] =>
  SELF_SERVE_PLANS.flatMap((plan) =>
    getKnownPlanVersions(plan).flatMap((planVersion) =>
      Object.values(BILLING_INTERVAL).flatMap((interval) =>
        getStripePriceReferences(plan, interval, planVersion),
      ),
    ),
  );

export const getPlanSelectionFromStripePriceId = (
  priceId: string,
): StripePlanSelection | null =>
  getPlanSelectionFromStripeReferences({
    references: getAllStripePriceReferences(),
    priceId,
  });

export const getPlanSelectionFromStripeLookupKey = (
  lookupKey: string,
): StripePlanSelection | null =>
  getPlanSelectionFromStripeReferences({
    references: getAllStripePriceReferences(),
    lookupKey,
  });

export const getBasePlanCatalog = () => {
  const currentOffer = getCurrentCommercialOffer();

  return PLAN_ORDER.map((plan) => {
    const version = getCurrentPlanVersion(plan);
    const planOffer = currentOffer.plans[plan];

    if (planOffer.entitlementVersion !== version) {
      throw new Error(
        `Commercial offer ${currentOffer.id} targets ${plan} V${planOffer.entitlementVersion}, not current V${version}.`,
      );
    }

    return {
      id: plan,
      selfServe: isSelfServePlan(plan),
      ...getPlanConfig(plan, version),
      commercial: {
        offerId: currentOffer.id,
        founding: currentOffer.founding,
        displayName: planOffer.displayName,
        positioning: planOffer.positioning ?? null,
        recommended: planOffer.recommended,
        saleMode: planOffer.saleMode,
        newSaleCurrencies: [...currentOffer.newSaleCurrencies],
        annualSavingsMonths: currentOffer.annualSavingsMonths,
        recurring: structuredClone(planOffer.recurring),
        onboarding: structuredClone(planOffer.onboarding),
      },
    };
  });
};

export type PlanChangeTiming = "none" | "immediate" | "period_end";

export const getPlanChangeTiming = ({
  currentPlan,
  currentInterval,
  targetPlan,
  targetInterval,
}: {
  currentPlan: TenantPlan;
  currentInterval: BillingInterval;
  targetPlan: TenantPlan;
  targetInterval: BillingInterval;
}): PlanChangeTiming => {
  if (currentPlan === targetPlan && currentInterval === targetInterval) {
    return "none";
  }

  const currentPlanRank = PLAN_ORDER.indexOf(currentPlan);
  const targetPlanRank = PLAN_ORDER.indexOf(targetPlan);

  if (targetPlanRank > currentPlanRank) {
    return "immediate";
  }

  if (targetPlanRank < currentPlanRank) {
    return "period_end";
  }

  return currentInterval === BILLING_INTERVAL.MONTHLY &&
    targetInterval === BILLING_INTERVAL.YEARLY
    ? "immediate"
    : "period_end";
};

// Kept public for the provisioning command and operational diagnostics.
export { getCommercialStripeLookupKey };
