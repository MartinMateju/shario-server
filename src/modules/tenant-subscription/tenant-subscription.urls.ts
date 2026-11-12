import { internalServerError } from "@/shared/http/httpErrors.js";

const getClientUrl = (): URL => {
  const clientUrl = process.env.CLIENT_URL?.trim();

  if (!clientUrl) {
    internalServerError("CLIENT_URL is not configured.");
  }

  return new URL(clientUrl);
};

export const getTenantClientUrl = (tenantSlug: string): URL => {
  const url = getClientUrl();
  const rootHostname = url.hostname.toLowerCase().replace(/^www\./, "");

  if (!url.hostname.startsWith(`${tenantSlug}.`)) {
    url.hostname = `${tenantSlug}.${rootHostname}`;
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";

  return url;
};

export const getTenantBillingUrl = ({
  tenantSlug,
  locale,
  checkout,
}: {
  tenantSlug: string;
  locale: string;
  checkout?: "success" | "cancelled";
}): string => {
  const url = getTenantClientUrl(tenantSlug);
  url.pathname = `/${locale}/app/settings/billing`;

  if (checkout) {
    url.searchParams.set("checkout", checkout);
  }

  return url.toString();
};
