import { isValidTenantSlug } from "@/modules/tenants/tenant.validators.js";
import { internalServerError } from "@/shared/http/httpErrors.js";

import type {
  TenantPaymentConnectLocale,
  TenantPaymentConnectSetupStep,
} from "./tenant-payment.validators.js";

const getClientUrl = (): URL => {
  const value = process.env.CLIENT_URL?.trim();

  if (!value) {
    internalServerError({
      message: "CLIENT_URL is not configured.",
      code: "CLIENT_URL_NOT_CONFIGURED",
    });
  }

  return new URL(value);
};

export const getTenantPaymentSettingsUrl = ({
  tenantSlug,
  locale,
  outcome,
  setupStep,
}: {
  tenantSlug: string;
  locale: TenantPaymentConnectLocale;
  outcome?: "return" | "refresh";
  setupStep?: TenantPaymentConnectSetupStep;
}): string => {
  if (!isValidTenantSlug(tenantSlug)) {
    throw new Error("A valid tenant slug is required to build a Connect URL.");
  }

  const url = getClientUrl();
  const rootHostname = url.hostname.toLowerCase().replace(/^www\./, "");

  if (!url.hostname.toLowerCase().startsWith(`${tenantSlug}.`)) {
    url.hostname = `${tenantSlug}.${rootHostname}`;
  }

  url.pathname = `/${locale}/app/settings/payments`;
  url.search = "";
  url.hash = "";

  if (outcome) {
    url.searchParams.set("connect", outcome);
  }

  if (setupStep) {
    url.searchParams.set("setupStep", setupStep);
  }

  return url.toString();
};

export const getTenantPaymentConnectUrls = ({
  tenantSlug,
  locale,
  setupStep,
}: {
  tenantSlug: string;
  locale: TenantPaymentConnectLocale;
  setupStep?: TenantPaymentConnectSetupStep;
}): { refreshUrl: string; returnUrl: string } => ({
  refreshUrl: getTenantPaymentSettingsUrl({
    tenantSlug,
    locale,
    outcome: "refresh",
    setupStep,
  }),
  returnUrl: getTenantPaymentSettingsUrl({
    tenantSlug,
    locale,
    outcome: "return",
    setupStep,
  }),
});
