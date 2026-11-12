// Kept as a compatibility entry point. Tenant entitlements have one source of
// truth so checkout, middleware and the tenant snapshot cannot drift apart.
export { PLAN_CONFIG, getPlanConfig } from "@/modules/tenants/tenant.plan.js";
export { applyPlanToTenant } from "@/modules/tenants/tenant.utils.js";
export type { TenantPlan as PlanName } from "@/modules/tenants/tenant.types.js";
