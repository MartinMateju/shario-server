import type { TenantDocument } from "@/modules/tenants/tenant.types.js";
import { findActiveTenantByHostname } from "@/modules/tenants/tenant.repository.js";

type TenantDomainLookup = (hostname: string) => Promise<TenantDocument | null>;

const CUSTOM_DOMAIN_CACHE_TTL_MS = 60_000;
const CUSTOM_DOMAIN_CACHE_MAX_ENTRIES = 1_000;
const CUSTOM_DOMAIN_LOOKUP_MAX_CONCURRENCY = 16;
const CUSTOM_DOMAIN_LOOKUP_BURST = 64;
const CUSTOM_DOMAIN_LOOKUP_REFILL_PER_SECOND = 1;

type CachedDomainDecision = {
  allowed: boolean;
  expiresAt: number;
};

const customDomainCache = new Map<string, CachedDomainDecision>();
const customDomainLookups = new Map<string, Promise<boolean>>();
let activeCustomDomainLookups = 0;
let lastCustomDomainCacheSweepAt = 0;
let customDomainLookupTokens = CUSTOM_DOMAIN_LOOKUP_BURST;
let customDomainLookupTokenRefillAt = Date.now();

const takeCustomDomainLookupToken = (now: number): boolean => {
  const elapsedSeconds = Math.max(
    0,
    (now - customDomainLookupTokenRefillAt) / 1_000,
  );

  customDomainLookupTokens = Math.min(
    CUSTOM_DOMAIN_LOOKUP_BURST,
    customDomainLookupTokens +
      elapsedSeconds * CUSTOM_DOMAIN_LOOKUP_REFILL_PER_SECOND,
  );
  customDomainLookupTokenRefillAt = now;

  if (customDomainLookupTokens < 1) {
    return false;
  }

  customDomainLookupTokens -= 1;
  return true;
};

const sweepExpiredCustomDomainCache = (now: number): void => {
  if (now - lastCustomDomainCacheSweepAt < CUSTOM_DOMAIN_CACHE_TTL_MS) {
    return;
  }

  lastCustomDomainCacheSweepAt = now;

  for (const [hostname, decision] of customDomainCache.entries()) {
    if (decision.expiresAt <= now) {
      customDomainCache.delete(hostname);
    }
  }
};

const getCachedCustomDomainDecision = (
  hostname: string,
  now: number,
): boolean | undefined => {
  const cached = customDomainCache.get(hostname);

  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= now) {
    customDomainCache.delete(hostname);
    return undefined;
  }

  // Refresh insertion order so the bounded cache evicts the least recently
  // used hostname rather than an actively used tenant domain.
  customDomainCache.delete(hostname);
  customDomainCache.set(hostname, cached);

  return cached.allowed;
};

const cacheCustomDomainDecision = (
  hostname: string,
  allowed: boolean,
  now: number,
): void => {
  sweepExpiredCustomDomainCache(now);
  customDomainCache.delete(hostname);

  while (customDomainCache.size >= CUSTOM_DOMAIN_CACHE_MAX_ENTRIES) {
    const oldestHostname = customDomainCache.keys().next().value;

    if (typeof oldestHostname !== "string") {
      break;
    }

    customDomainCache.delete(oldestHostname);
  }

  customDomainCache.set(hostname, {
    allowed,
    expiresAt: now + CUSTOM_DOMAIN_CACHE_TTL_MS,
  });
};

const normalizeConfiguredOrigin = (value: unknown): string => {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
};

const configuredOrigins = new Set(
  [
    process.env.PUBLIC_APP_URL,
    process.env.CLIENT_URL,
    ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(","),
  ]
    .map(normalizeConfiguredOrigin)
    .filter(Boolean),
);

const normalizeHostname = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

const developmentRootDomain = normalizeHostname(
  process.env.DEVELOPMENT_ROOT_DOMAIN || "localhost",
);

const isDevelopmentFrontendHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === developmentRootDomain ||
  hostname.endsWith(`.${developmentRootDomain}`);

const isPlatformFrontendOrigin = (url: URL): boolean => {
  const hostname = normalizeHostname(url.hostname);

  if (
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    url.port === "3000" &&
    isDevelopmentFrontendHostname(hostname)
  ) {
    return true;
  }

  return (
    url.protocol === "https:" &&
    url.port === "" &&
    (hostname === "shario.io" || hostname.endsWith(".shario.io"))
  );
};

const isCustomDomainProtocolAllowed = (url: URL): boolean =>
  process.env.NODE_ENV === "production"
    ? url.protocol === "https:" && url.port === ""
    : ["http:", "https:"].includes(url.protocol);

const lookupCustomDomain = async (
  hostname: string,
  lookupTenant: TenantDomainLookup,
): Promise<boolean> => {
  const now = Date.now();
  const cached = getCachedCustomDomainDecision(hostname, now);

  if (cached !== undefined) {
    return cached;
  }

  const pendingLookup = customDomainLookups.get(hostname);

  if (pendingLookup) {
    return pendingLookup;
  }

  // The CORS middleware executes before route-level rate limiters. Rejecting
  // excess uncached lookups here keeps forged Origin headers from exhausting
  // the Mongo connection pool. Cached platform and tenant origins are not
  // affected by this guard.
  if (activeCustomDomainLookups >= CUSTOM_DOMAIN_LOOKUP_MAX_CONCURRENCY) {
    return false;
  }

  // Bound the sustained database work caused by attacker-controlled Origin
  // hostnames. Cached and coalesced tenant origins never consume this budget.
  if (!takeCustomDomainLookupToken(now)) {
    return false;
  }

  activeCustomDomainLookups += 1;

  const lookup = (async (): Promise<boolean> => {
    try {
      const tenant = await lookupTenant(hostname);
      const allowed = Boolean(tenant);

      cacheCustomDomainDecision(hostname, allowed, Date.now());

      return allowed;
    } finally {
      activeCustomDomainLookups = Math.max(0, activeCustomDomainLookups - 1);
      customDomainLookups.delete(hostname);
    }
  })();

  customDomainLookups.set(hostname, lookup);

  return lookup;
};

/**
 * Authorizes credentialed browser origins.
 *
 * Platform and configured origins are resolved locally. A custom hostname is
 * accepted only when it belongs to an active, non-suspended tenant in the
 * database. Lookup failures are intentionally left to the caller so CORS
 * fails closed instead of reflecting an unverified Origin header.
 */
export const isCorsOriginAllowed = async (
  origin: string,
  lookupTenant: TenantDomainLookup = findActiveTenantByHostname,
): Promise<boolean> => {
  const normalizedOrigin = normalizeConfiguredOrigin(origin);

  if (!normalizedOrigin) {
    return false;
  }

  if (configuredOrigins.has(normalizedOrigin)) {
    return true;
  }

  const url = new URL(normalizedOrigin);

  if (isPlatformFrontendOrigin(url)) {
    return true;
  }

  if (!isCustomDomainProtocolAllowed(url)) {
    return false;
  }

  return lookupCustomDomain(normalizeHostname(url.hostname), lookupTenant);
};

export const clearCorsCustomDomainCache = (): void => {
  customDomainCache.clear();
  customDomainLookups.clear();
  activeCustomDomainLookups = 0;
  lastCustomDomainCacheSweepAt = 0;
  customDomainLookupTokens = CUSTOM_DOMAIN_LOOKUP_BURST;
  customDomainLookupTokenRefillAt = Date.now();
};
