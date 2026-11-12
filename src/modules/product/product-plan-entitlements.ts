import { getPlanCapabilities } from "@/modules/tenants/tenant.plan.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import { forbidden } from "@/shared/http/httpErrors.js";

import {
  normalizeProductKindV2,
  PRODUCT_KIND,
  resolveLegacyProductTypeV2,
  type ProductKind,
} from "./product-kind-v2.contract.js";

type TenantPlanSelection = {
  plan?: TenantPlan;
  planVersion?: number;
};

const resolveProductKind = (product: unknown): ProductKind | null => {
  if (!product || typeof product !== "object") return null;

  const record = product as { kind?: unknown; type?: unknown };
  const canonical = normalizeProductKindV2(record.kind);
  if (canonical) return canonical;

  const legacy = resolveLegacyProductTypeV2(record.type);
  return legacy.status === "mapped" ? legacy.kind : null;
};

export const isProductKindEntitledForTenant = ({
  tenant,
  kind,
}: {
  tenant: TenantPlanSelection;
  kind: ProductKind | null;
}): boolean => {
  if (kind !== PRODUCT_KIND.OPEN_STUDIO) return true;

  // Some legacy callers intentionally load only the tenant identifier. Before
  // plan entitlements were introduced those projections allowed every product
  // kind, so an absent plan must retain that behavior. A present V3 selection
  // still resolves through the immutable capability catalogue below.
  if (tenant.plan == null) return true;

  const capabilities = getPlanCapabilities(
    tenant.plan,
    Number(tenant.planVersion ?? 1),
  );
  return capabilities?.booking.openStudio !== false;
};

export const assertProductKindEntitledForTenant = ({
  tenant,
  kind,
}: {
  tenant: TenantPlanSelection;
  kind: ProductKind | null;
}): void => {
  if (isProductKindEntitledForTenant({ tenant, kind })) return;

  forbidden({
    message: "Open Studio is not included in the current plan.",
    code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
    details: {
      capability: "openStudio",
      currentPlan: tenant.plan,
      planVersion: Number(tenant.planVersion ?? 1),
    },
  });
};

export const assertProductsEntitledForTenant = ({
  tenant,
  products,
}: {
  tenant: TenantPlanSelection;
  products: readonly unknown[];
}): void => {
  for (const product of products) {
    assertProductKindEntitledForTenant({
      tenant,
      kind: resolveProductKind(product),
    });
  }
};
