import type Stripe from "stripe";

import { internalServerError } from "@/shared/http/httpErrors.js";

export const TENANT_BILLING_PORTAL_PURPOSE =
  "shario_tenant_billing" as const;

export const TENANT_BILLING_PORTAL_VERSION = "1" as const;

type PortalLegalLinks = {
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
};

export const buildTenantBillingPortalConfiguration = ({
  privacyPolicyUrl,
  termsOfServiceUrl,
}: PortalLegalLinks = {}): Stripe.BillingPortal.ConfigurationCreateParams => ({
  business_profile: {
    ...(privacyPolicyUrl
      ? { privacy_policy_url: privacyPolicyUrl }
      : {}),
    ...(termsOfServiceUrl
      ? { terms_of_service_url: termsOfServiceUrl }
      : {}),
  },
  features: {
    customer_update: {
      enabled: true,
      // Billing email is deliberately excluded. Authentication email changes
      // belong in Shario's account settings and must remain verified there.
      allowed_updates: ["address", "name", "phone", "tax_id"],
    },
    invoice_history: {
      enabled: true,
    },
    payment_method_update: {
      enabled: true,
    },
    // Plan changes and cancellation follow Shario's own proration, scheduling
    // and cancellation rules instead of Stripe Portal defaults.
    subscription_cancel: {
      enabled: false,
    },
    subscription_pause: {
      enabled: false,
    },
    subscription_update: {
      enabled: false,
      default_allowed_updates: [],
      products: [],
    },
  },
  login_page: {
    enabled: false,
  },
  metadata: {
    managedBy: "shario.io",
    purpose: TENANT_BILLING_PORTAL_PURPOSE,
    version: TENANT_BILLING_PORTAL_VERSION,
  },
});

export const isManagedTenantBillingPortalConfiguration = (
  configuration: Stripe.BillingPortal.Configuration,
): boolean =>
  configuration.metadata?.purpose === TENANT_BILLING_PORTAL_PURPOSE;

export const isSafeTenantBillingPortalConfiguration = (
  configuration: Stripe.BillingPortal.Configuration,
): boolean => {
  const features = configuration.features;
  const allowedCustomerUpdates =
    features.customer_update.allowed_updates ?? [];

  return Boolean(
    configuration.active &&
      features.customer_update.enabled &&
      allowedCustomerUpdates.includes("address") &&
      allowedCustomerUpdates.includes("name") &&
      allowedCustomerUpdates.includes("tax_id") &&
      !allowedCustomerUpdates.includes("email") &&
      features.invoice_history.enabled &&
      features.payment_method_update.enabled &&
      !features.subscription_cancel.enabled &&
      !features.subscription_pause?.enabled &&
      !features.subscription_update.enabled &&
      !configuration.login_page.enabled,
  );
};

let cachedPortalConfigurationId: string | null = null;

const getConfiguredPortalConfigurationId = (): string | null =>
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim() || null;

const requireSafeConfiguration = (
  configuration: Stripe.BillingPortal.Configuration,
): Stripe.BillingPortal.Configuration => {
  if (!isSafeTenantBillingPortalConfiguration(configuration)) {
    internalServerError({
      message: "The Stripe Billing Portal configuration is not safe to use.",
      code: "STRIPE_BILLING_PORTAL_MISCONFIGURED",
    });
  }

  return configuration;
};

export const resolveTenantBillingPortalConfigurationId = async (
  stripe: Stripe,
): Promise<string> => {
  if (cachedPortalConfigurationId) {
    return cachedPortalConfigurationId;
  }

  const configuredId = getConfiguredPortalConfigurationId();

  if (configuredId) {
    const configuration = requireSafeConfiguration(
      await stripe.billingPortal.configurations.retrieve(configuredId),
    );

    cachedPortalConfigurationId = configuration.id;
    return configuration.id;
  }

  const configurations = await stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  });
  const managedConfiguration = configurations.data.find(
    isManagedTenantBillingPortalConfiguration,
  );

  if (!managedConfiguration) {
    internalServerError({
      message:
        "Stripe Billing Portal is not configured. Run npm run stripe:setup-billing-portal.",
      code: "STRIPE_BILLING_PORTAL_NOT_CONFIGURED",
    });
  }

  const safeConfiguration = requireSafeConfiguration(managedConfiguration);
  cachedPortalConfigurationId = safeConfiguration.id;
  return safeConfiguration.id;
};

export const upsertTenantBillingPortalConfiguration = async (
  stripe: Stripe,
  links: PortalLegalLinks = {},
): Promise<Stripe.BillingPortal.Configuration> => {
  const configuredId = getConfiguredPortalConfigurationId();
  let existing: Stripe.BillingPortal.Configuration | undefined;

  if (configuredId) {
    existing = await stripe.billingPortal.configurations.retrieve(configuredId);
  } else {
    const configurations = await stripe.billingPortal.configurations.list({
      active: true,
      limit: 100,
    });
    existing = configurations.data.find(
      isManagedTenantBillingPortalConfiguration,
    );
  }

  const desired = buildTenantBillingPortalConfiguration(links);
  const configuration = existing
    ? await stripe.billingPortal.configurations.update(existing.id, {
        active: true,
        business_profile: {
          privacy_policy_url: links.privacyPolicyUrl ?? "",
          terms_of_service_url: links.termsOfServiceUrl ?? "",
        },
        features: desired.features,
        login_page: desired.login_page,
        metadata: desired.metadata,
      })
    : await stripe.billingPortal.configurations.create(desired, {
        idempotencyKey: [
          "shario-tenant-billing-portal",
          TENANT_BILLING_PORTAL_VERSION,
        ].join(":"),
      });

  cachedPortalConfigurationId = configuration.id;
  return requireSafeConfiguration(configuration);
};
