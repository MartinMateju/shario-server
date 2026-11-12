import {
  resolveRolloutEligibleAppLocale,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";
import { isTenantDomainEntitled } from "@/modules/tenants/tenant-domain-entitlement.js";

type TenantUrlContext = {
  slug: string;
  plan?: unknown;
  planVersion?: unknown;
  domains?: Array<{
    hostname?: string;
    status?: string;
    type?: string;
  }>;
};

export type CommerceLocale = RolloutEligibleAppLocale;

/**
 * Checkout links must preserve every locale that is eligible for the current
 * rollout. Unknown and not-yet-enabled locales deliberately fall back to
 * English instead of creating an unsupported route.
 */
export const normalizeCommerceLocale = (value: unknown): CommerceLocale =>
  resolveRolloutEligibleAppLocale(value);

const normalizeHostname = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

const developmentRootDomain = (): string =>
  normalizeHostname(process.env.DEVELOPMENT_ROOT_DOMAIN || "localhost");

const standardTenantOrigin = (tenantSlug: string): string => {
  const slug = normalizeHostname(tenantSlug);

  if (process.env.NODE_ENV === "production") {
    return `https://${slug}.shario.io`;
  }

  const configuredClient = new URL(process.env.CLIENT_URL || "http://shario.localhost:4310");
  const port = configuredClient.port ? `:${configuredClient.port}` : "";
  return `${configuredClient.protocol}//${slug}.${developmentRootDomain()}${port}`;
};

const activeCustomHostnames = (tenant: TenantUrlContext): Set<string> =>
  new Set(
    (tenant.domains ?? [])
      .filter(
        (domain) =>
          domain.status === "active" &&
          isTenantDomainEntitled({ tenant, domain }),
      )
      .map((domain) => normalizeHostname(domain.hostname))
      .filter(Boolean),
  );

/**
 * Returns a tenant-owned browser origin. Client supplied origins are accepted
 * only when they are the standard tenant subdomain or an active custom domain;
 * arbitrary Checkout success/cancel redirects are never reflected.
 */
export const resolveTenantCommerceOrigin = ({
  tenant,
  requestedOrigin,
}: {
  tenant: TenantUrlContext;
  requestedOrigin?: unknown;
}): string => {
  const standard = standardTenantOrigin(tenant.slug);
  const customHosts = activeCustomHostnames(tenant);

  if (typeof requestedOrigin !== "string" || !requestedOrigin.trim()) {
    return standard;
  }

  try {
    const candidate = new URL(requestedOrigin);
    const standardUrl = new URL(standard);
    const hostname = normalizeHostname(candidate.hostname);
    const isStandard =
      hostname === normalizeHostname(standardUrl.hostname) &&
      candidate.protocol === standardUrl.protocol &&
      candidate.port === standardUrl.port;
    const isCustom =
      customHosts.has(hostname) &&
      (process.env.NODE_ENV === "production"
        ? candidate.protocol === "https:" && candidate.port === ""
        : ["http:", "https:"].includes(candidate.protocol));

    if (isStandard || isCustom) {
      return candidate.origin;
    }
  } catch {
    // Fall through to the server-derived standard tenant origin.
  }

  return standard;
};

export const buildTenantCommerceUrl = ({
  origin,
  locale,
  path,
  query,
}: {
  origin: string;
  locale: CommerceLocale;
  path: string;
  query?: Record<string, string>;
}): string => {
  const url = new URL(`/${locale}/${path.replace(/^\/+/, "")}`, origin);

  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
};
