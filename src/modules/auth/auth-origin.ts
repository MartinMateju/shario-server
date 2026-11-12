import { TENANT_DOMAIN_STATUS } from "@/modules/tenants/tenant.constants.js";
import { isTenantDomainEntitled } from "@/modules/tenants/tenant-domain-entitlement.js";
import type { AuthTenantForToken } from "@/modules/auth/auth.types.js";
import { forbidden } from "@/shared/http/httpErrors.js";

type AuthOriginTenant = AuthTenantForToken & {
  domains?: Array<{
    hostname?: string;
    status?: string;
    type?: string;
  }>;
};

const normalizeHostname = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

const parseOrigin = (value: unknown): URL | null => {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
};

const configuredPlatformOrigins = (): Set<string> => {
  const values = [
    process.env.CLIENT_URL,
    process.env.PUBLIC_APP_URL,
    process.env.SERVER_URL,
  ];
  const origins = values
    .map(parseOrigin)
    .filter((value): value is URL => Boolean(value))
    .map((value) => value.origin);

  if (process.env.NODE_ENV === "production") {
    origins.push(
      "https://shario.io",
      "https://www.shario.io",
      "https://app.shario.io",
      "https://admin.shario.io",
      "https://api.shario.io",
    );
  } else {
    origins.push("http://localhost:4310");

    for (const root of getDevelopmentRootDomains()) {
      origins.push(`http://${root}:4310`);
    }
  }

  return new Set(origins);
};

const getDevelopmentRootDomains = (): Set<string> => {
  const configured = normalizeHostname(
    process.env.DEVELOPMENT_ROOT_DOMAIN,
  );

  /*
   * CLIENT_URL is commonly http://localhost:4310 even though tenant
   * workspaces use <slug>.shario.localhost. Deriving the tenant root from that
   * URL made every tenant login and refresh fail unless the optional
   * DEVELOPMENT_ROOT_DOMAIN variable happened to be present.
   *
   * Keep both supported loopback conventions available, and add an explicit
   * development root when one is configured. The tenant slug still has to be
   * the exact first label, so accepting both roots does not permit one
   * tenant's subdomain to authenticate another tenant.
   */
  return new Set(
    [
      configured,
      "shario.localhost",
      "localhost",
    ].filter(Boolean),
  );
};

const isTenantPlatformSubdomain = (
  url: URL,
  tenantSlug: string,
): boolean => {
  if (!tenantSlug) {
    return false;
  }

  const hostname = normalizeHostname(url.hostname);

  if (process.env.NODE_ENV === "production") {
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      hostname === `${tenantSlug}.shario.io`
    );
  }

  return (
    ["http:", "https:"].includes(url.protocol) &&
    [...getDevelopmentRootDomains()].some(
      (root) => hostname === `${tenantSlug}.${root}`,
    )
  );
};

const isActiveTenantCustomDomain = (
  url: URL,
  tenant: AuthOriginTenant,
): boolean => {
  if (
    process.env.NODE_ENV === "production" &&
    (url.protocol !== "https:" || url.port !== "")
  ) {
    return false;
  }

  const hostname = normalizeHostname(url.hostname);

  return (tenant.domains || []).some(
    (domain) =>
      domain.status === TENANT_DOMAIN_STATUS.ACTIVE &&
      normalizeHostname(domain.hostname) === hostname &&
      isTenantDomainEntitled({ tenant, domain }),
  );
};

/**
 * Binds credentialed browser authentication to the tenant that owns the
 * session. CORS establishes that an origin belongs to some active tenant;
 * this assertion establishes that it belongs to this exact tenant.
 *
 * Requests without Origin remain available to trusted non-browser clients.
 * Browser POST requests include Origin and therefore cannot use one tenant's
 * active custom domain to rotate another tenant's API-host refresh cookie.
 */
export const assertTenantAuthOrigin = ({
  origin,
  tenant,
}: {
  origin?: string | null;
  tenant: AuthOriginTenant;
}): void => {
  if (!String(origin ?? "").trim()) {
    return;
  }

  const url = parseOrigin(origin);
  const slug = String(tenant.slug ?? "").trim().toLowerCase();
  const allowed =
    Boolean(url) &&
    (
      configuredPlatformOrigins().has(url.origin) ||
      isTenantPlatformSubdomain(url, slug) ||
      isActiveTenantCustomDomain(url, tenant)
    );

  if (!allowed) {
    forbidden({
      message: "This authentication request does not belong to the workspace.",
      code: "AUTH_ORIGIN_TENANT_MISMATCH",
    });
  }
};

export default assertTenantAuthOrigin;
