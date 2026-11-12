import {
  TENANT_DOMAIN_TYPE,
  TENANT_PLAN,
} from "./tenant.constants.js";
import { getPlanConfig } from "./tenant.plan.js";
import type { TenantPlan } from "./tenant.types.js";

type TenantDomainEntitlementContext = {
  plan?: unknown;
  planVersion?: unknown;
};

type TenantDomainEntitlementDomain = {
  type?: unknown;
};

const isTenantPlan = (value: unknown): value is TenantPlan =>
  (Object.values(TENANT_PLAN) as readonly unknown[]).includes(value);

/**
 * Standard shario.io subdomains remain available on every plan. Historical
 * custom domains retain their V1/V2 behavior; Plan V3 custom hosts require
 * the explicit Studio Plus/Enterprise website entitlement.
 */
export const isTenantDomainEntitled = ({
  tenant,
  domain,
}: {
  tenant: TenantDomainEntitlementContext;
  domain: TenantDomainEntitlementDomain;
}): boolean => {
  if (domain.type === TENANT_DOMAIN_TYPE.SUBDOMAIN) return true;

  // Missing versions predate the versioned entitlement rollout.
  const planVersion = Number(tenant.planVersion ?? 2);
  if (Number.isFinite(planVersion) && planVersion < 3) return true;
  if (!isTenantPlan(tenant.plan) || !Number.isFinite(planVersion)) return false;

  try {
    return (
      getPlanConfig(tenant.plan, planVersion).capabilities?.website
        .customDomain === true
    );
  } catch {
    return false;
  }
};
