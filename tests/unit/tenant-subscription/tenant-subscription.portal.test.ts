import { describe, expect, it } from "vitest";

import {
  buildTenantBillingPortalConfiguration,
  isManagedTenantBillingPortalConfiguration,
  isSafeTenantBillingPortalConfiguration,
  TENANT_BILLING_PORTAL_PURPOSE,
} from "@/modules/tenant-subscription/tenant-subscription.portal.js";

const asPortalConfiguration = (
  overrides: Record<string, unknown> = {},
) =>
  ({
    id: "bpc_test",
    object: "billing_portal.configuration",
    active: true,
    application: null,
    business_profile: {
      headline: null,
      privacy_policy_url: null,
      terms_of_service_url: null,
    },
    created: 1,
    default_return_url: null,
    features: {
      customer_update: {
        allowed_updates: ["address", "name", "phone", "tax_id"],
        enabled: true,
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        cancellation_reason: { enabled: false, options: [] },
        enabled: false,
        mode: "at_period_end",
        proration_behavior: "none",
      },
      subscription_pause: { enabled: false },
      subscription_update: {
        default_allowed_updates: [],
        enabled: false,
        products: [],
        proration_behavior: "none",
      },
    },
    is_default: false,
    livemode: false,
    login_page: { enabled: false, url: null },
    metadata: { purpose: TENANT_BILLING_PORTAL_PURPOSE },
    updated: 1,
    ...overrides,
  }) as any;

describe("tenant Billing Portal configuration", () => {
  it("enables billing recovery features without exposing subscription rules", () => {
    const configuration = buildTenantBillingPortalConfiguration();
    const features = configuration.features;

    expect(features.payment_method_update?.enabled).toBe(true);
    expect(features.invoice_history?.enabled).toBe(true);
    expect(features.customer_update?.allowed_updates).toEqual([
      "address",
      "name",
      "phone",
      "tax_id",
    ]);
    expect(features.customer_update?.allowed_updates).not.toContain("email");
    expect(features.subscription_cancel?.enabled).toBe(false);
    expect(features.subscription_pause?.enabled).toBe(false);
    expect(features.subscription_update?.enabled).toBe(false);
    expect(configuration.login_page?.enabled).toBe(false);
  });

  it("recognizes the managed safe configuration", () => {
    const configuration = asPortalConfiguration();

    expect(isManagedTenantBillingPortalConfiguration(configuration)).toBe(true);
    expect(isSafeTenantBillingPortalConfiguration(configuration)).toBe(true);
  });

  it("rejects a configuration that permits Stripe-side cancellation", () => {
    const configuration = asPortalConfiguration();
    configuration.features.subscription_cancel.enabled = true;

    expect(isSafeTenantBillingPortalConfiguration(configuration)).toBe(false);
  });

  it("rejects billing-email changes that could desynchronize authentication", () => {
    const configuration = asPortalConfiguration();
    configuration.features.customer_update.allowed_updates.push("email");

    expect(isSafeTenantBillingPortalConfiguration(configuration)).toBe(false);
  });
});
