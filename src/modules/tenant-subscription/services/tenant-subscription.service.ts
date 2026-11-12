import type { ClientSession } from "mongoose";
import { isMongoDuplicateKeyError } from "@/infrastructure/database/mongo-errors.js";

import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { getCurrentPlanVersion } from "@/modules/tenants/tenant.plan.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { notFound } from "@/shared/http/httpErrors.js";
import type { PlatformBillingCurrency } from "@/shared/money/currency.js";

import { getSubscriptionAccess } from "../tenant-subscription.access.js";
import {
  TENANT_SUBSCRIPTION_STATUS,
  TENANT_TRIAL_DAYS,
} from "../tenant-subscription.constants.js";
import {
  createPendingSubscription,
  expireElapsedTrials,
  findSubscriptionByTenant,
} from "../tenant-subscription.repository.js";
import TenantSubscriptionModel from "../tenant-subscription.schema.js";

type SubscriptionServiceOptions = {
  session?: ClientSession | null;
};

/**
 * How long a resolved {tenant, subscription, access} tuple may be served
 * from cache, and the key it's cached under.
 *
 * There is no explicit invalidation for this one: subscription writes
 * happen across several `.save()` call sites in the Stripe webhook and
 * billing services rather than through one repository chokepoint, so this
 * relies entirely on the short TTL to bound staleness after a plan change,
 * trial expiry, or tenant status change. Given this gates the whole
 * authenticated tenant-feature API surface, a wrong-for-up-to-30s access
 * decision is an accepted trade-off for now; add precise invalidation at
 * the relevant write sites if that turns out not to be tight enough.
 */
export const TENANT_SUBSCRIPTION_ACCESS_CACHE_TTL_SECONDS = Number(
  process.env.TENANT_SUBSCRIPTION_ACCESS_CACHE_TTL_SECONDS || 30,
);

export const tenantSubscriptionAccessCacheKey = (tenantId: string): string =>
  `shario:tenant-subscription-access:${tenantId}`;

const addDays = (date: Date, days: number): Date => {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
};

export const createPendingTenantSubscription = async ({
  tenantId,
  session,
  billingCurrency,
}: {
  tenantId: string;
  session?: ClientSession | null;
  billingCurrency?: PlatformBillingCurrency;
}) => {
  return createPendingSubscription(tenantId, { session, billingCurrency });
};

export const ensureTenantSubscription = async (
  tenantId: string,
  options: SubscriptionServiceOptions = {},
) => {
  const existing = await findSubscriptionByTenant(tenantId, options);

  if (existing) return existing;

  try {
    return await createPendingSubscription(tenantId, options);
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }

    const concurrentlyCreated = await findSubscriptionByTenant(
      tenantId,
      options,
    );

    if (!concurrentlyCreated) {
      throw error;
    }

    return concurrentlyCreated;
  }
};

export const startTenantTrial = async ({
  tenantId,
  session,
  now = new Date(),
}: {
  tenantId: string;
  session?: ClientSession | null;
  now?: Date;
}) => {
  const subscription = await ensureTenantSubscription(tenantId, { session });

  // A trial is a one-time transition. Replaying onboarding completion must not
  // extend it, and paid/canceled workspaces keep their billing history.
  if (
    subscription.status !== TENANT_SUBSCRIPTION_STATUS.PENDING ||
    subscription.trialUsedAt
  ) {
    return { subscription, started: false as const };
  }

  subscription.status = TENANT_SUBSCRIPTION_STATUS.TRIALING;
  subscription.trialPlan = TENANT_PLAN.PROFESSIONAL;
  subscription.trialPlanVersion = getCurrentPlanVersion(
    TENANT_PLAN.PROFESSIONAL,
  );
  subscription.trialStartedAt = now;
  subscription.trialEndsAt = addDays(now, TENANT_TRIAL_DAYS);
  subscription.trialUsedAt = now;
  subscription.lastSyncedAt = now;

  await subscription.save(session ? { session } : undefined);

  return { subscription, started: true as const };
};

const resolveTenantSubscriptionAccess = async (tenantId: string) => {
  const [tenant, subscription] = await Promise.all([
    getTenantOrThrow(tenantId),
    ensureTenantSubscription(tenantId),
  ]);

  if (!subscription) {
    notFound("Tenant subscription not found.");
  }

  return {
    tenant: tenant.toObject(),
    subscription: subscription.toObject(),
    access: getSubscriptionAccess({
      tenantStatus: tenant.status,
      subscription,
    }),
  };
};

/**
 * Resolves the tenant document and subscription-access decision applied to
 * (nearly) every authenticated tenant-feature request. See the cache
 * constants above for the caching/invalidation trade-off.
 *
 * Loaded dynamically so this module (imported by most of the authenticated
 * request path) never requires REDIS_URL to be configured just to resolve
 * subscription access.
 */
export const getTenantSubscriptionAccess = async (tenantId: string) => {
  const { getOrSetCache } = await import("@/infrastructure/redis/cache.js");
  const cached = await getOrSetCache(
    tenantSubscriptionAccessCacheKey(tenantId),
    TENANT_SUBSCRIPTION_ACCESS_CACHE_TTL_SECONDS,
    () => resolveTenantSubscriptionAccess(tenantId),
  );

  return {
    ...cached,
    // Rehydrated so downstream consumers keep getting real Mongoose
    // documents, matching a cache miss: req.tenant needs a live document for
    // feature-module guards, and several callers read subscription period
    // fields (currentPeriodStart/trialEndsAt/etc.) as actual Date instances,
    // not the ISO strings a plain JSON round trip would leave behind.
    tenant: TenantModel.hydrate(cached.tenant),
    subscription: TenantSubscriptionModel.hydrate(cached.subscription),
  };
};

export const reconcileExpiredTenantTrials = async (): Promise<number> => {
  return expireElapsedTrials(new Date());
};
