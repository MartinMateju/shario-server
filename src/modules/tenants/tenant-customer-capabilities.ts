import { forbidden } from "@/shared/http/httpErrors.js";

export type TenantForCustomerCapabilities = {
  workspaceIntent?: { pricingMode?: string | null } | null;
  modules?: { firing?: boolean };
};

export type CustomerTenantCapabilities = { myWork: boolean };
export type CustomerPricingMode = "time";
export type LocationForCustomerCapabilities = {
  pricingMode?: CustomerPricingMode | null;
};

export const CUSTOMER_MY_WORK_DISABLED = {
  code: "CUSTOMER_MY_WORK_DISABLED",
  message: "My work is not enabled for this studio's time-based pricing.",
};

export const getEffectiveCustomerPricingMode = (
  tenant: TenantForCustomerCapabilities | null | undefined,
  location?: LocationForCustomerCapabilities | null,
): CustomerPricingMode | null => {
  return "time";
};

/** Existing workspaces without a pricing choice keep their previous access. */
export const isCustomerMyWorkEnabled = (
  tenant: TenantForCustomerCapabilities | null | undefined,
  location?: LocationForCustomerCapabilities | null,
): boolean => false;

export const assertCustomerMyWorkEnabled = (
  tenant: TenantForCustomerCapabilities | null | undefined,
  location?: LocationForCustomerCapabilities | null,
): void => {
  if (!isCustomerMyWorkEnabled(tenant, location))
    forbidden(CUSTOMER_MY_WORK_DISABLED);
};

/** A derived response field, never a stored flag or a change to staff modules. */
export const deriveCustomerTenantCapabilities = (
  tenant: TenantForCustomerCapabilities | null | undefined,
  location?: LocationForCustomerCapabilities | null,
): CustomerTenantCapabilities => ({
  myWork: false,
});
