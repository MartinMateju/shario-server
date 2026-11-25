import type { Request } from "express";
import rateLimit, { type AugmentedRequest, MemoryStore } from "express-rate-limit";

import { assertE2ETestMode } from "@/config/e2e-mode.js";
import { recordPublicSiteThrottle } from "@/infrastructure/operations/public-site-health.js";
import { logger } from "@/config/logger.js";
import {
  AUTH_PROXY_HEADERS,
  getVerifiedAuthProxyClientIp,
  prepareAuthRateLimitContext,
} from "@/modules/auth/auth-first-party-proxy.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { forbidden } from "@/shared/http/httpErrors.js";
import { verifiedProxyRateLimitKey } from "@/shared/middleware/verified-proxy-rate-limit.js";

const publicCommerceMutationStore = new MemoryStore();
const publicTenantLookupStore = new MemoryStore();
const publicConfigurationStore = new MemoryStore();
const publicCatalogueStore = new MemoryStore();

type PublicLookupBudget = "configuration" | "catalogue" | "lookup";

// Only exact, read-only public surfaces get the browsing allowance. In
// particular, order/token lookups, quotes, auth and mutations keep the old
// lookup budget. Do not key by slug: changing studios must not reset a budget.
const publicConfigurationPath =
  /^\/public\/tenants\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/config\/?$/i;
const publicCataloguePath =
  /^\/public\/tenants\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/(?:products(?:\/courses(?:\/(?:locations|overview))?|\/[a-z\d_-]+(?:\/sessions)?)?|booking\/(?:locations|availability|occupancy)|memberships|membership-plans|vouchers\/products|knowledge(?:\/[a-z\d_-]+)?)\/?$/i;

const publicLookupBudget = (req: Request): PublicLookupBudget => {
  if (req.method !== "GET") return "lookup";
  const path = (req.originalUrl || req.url).split("?")[0];
  if (publicConfigurationPath.test(path)) return "configuration";
  if (publicCataloguePath.test(path)) return "catalogue";
  return "lookup";
};

/**
 * Protects unauthenticated tenant-commerce mutations. The default IP key
 * generator is IPv6-safe and respects Express's configured trust proxy.
 */
export const publicCommerceMutationLimiter = rateLimit({
  store: publicCommerceMutationStore,
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many checkout requests. Please try again shortly.",
    code: "PUBLIC_COMMERCE_RATE_LIMITED",
  },
});

const createPublicLookupLimiter = (
  budget: PublicLookupBudget,
  store: MemoryStore,
  limit: number,
) => rateLimit({
  store,
  windowMs: 10 * 60 * 1000,
  limit,
  keyGenerator: verifiedProxyRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many public workspace requests. Please try again shortly.",
    code: "PUBLIC_TENANT_LOOKUP_RATE_LIMITED",
  },
  handler: (req, res, _next, options) => {
    // Record the first rejection per visitor/window only. Never log a raw
    // request, URL, query, tenant, IP or proof headers from a public lookup.
    if ((req as AugmentedRequest).rateLimit.used === limit + 1) {
      const verifiedProxy = Boolean(getVerifiedAuthProxyClientIp(req));
      if (budget === "configuration" && verifiedProxy) recordPublicSiteThrottle();
      logger.warn({
        event: "public_lookup.rate_limited",
        budget,
        limit,
        windowSeconds: 600,
        retryAfterSeconds: Number(res.getHeader("Retry-After")),
        verifiedProxy,
      }, "Public lookup budget exhausted.");
    }
    res.status(options.statusCode).json(options.message);
  },
});

// Configuration drives every public page and login branding. Browsing a
// catalogue must never spend its allowance. 600 reads permits a sustained
// request/second for SSR, hydration and availability, while remaining bounded.
const publicLookupLimiters = {
  configuration: createPublicLookupLimiter("configuration", publicConfigurationStore, 120),
  catalogue: createPublicLookupLimiter("catalogue", publicCatalogueStore, 600),
  lookup: createPublicLookupLimiter("lookup", publicTenantLookupStore, 120),
};

// Some public routers fall through a shared commerce boundary before reaching
// their own route middleware. Charge the HTTP request once, not once per mount.
const chargedPublicLookups = new WeakSet<Request>();

const publicSsrLookupPath =
  /^\/public\/tenants\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/(?:config|memberships|vouchers\/products|products\/(?:courses(?:\/(?:locations|overview))?|[a-z\d_-]+))$/i;

export const publicTenantLookupLimiter = asyncHandler(
  async (req, res, next) => {
    if (chargedPublicLookups.has(req)) return next();
    const hasProof = Object.values(AUTH_PROXY_HEADERS).some(
      (header) => req.get(header) !== undefined,
    );
    if (hasProof) {
      // Only anonymous, read-only SSR lookups may carry this proof. It changes
      // the limiter key to the signed visitor IP; it never bypasses the limit.
      const path = (req.originalUrl || req.url).split("?")[0];
      if (
        req.method !== "GET" ||
        !publicSsrLookupPath.test(path) ||
        !req.get(AUTH_PROXY_HEADERS.CLIENT_IP) ||
        req.get("cookie") !== undefined ||
        req.get("authorization") !== undefined ||
        req.body !== undefined
      ) {
        forbidden({
          code: "AUTH_FIRST_PARTY_PROXY_INVALID",
          message: "Invalid signed public lookup.",
        });
      }
      await prepareAuthRateLimitContext(req);
    }
    const budget = publicLookupBudget(req);
    res.setHeader("X-Shario-Public-Lookup-Budget", budget);
    chargedPublicLookups.add(req);
    return publicLookupLimiters[budget](req, res, next);
  },
);

/** Clear these in-memory counters only when the hermetic harness resets its fixtures. */
export const resetPublicCommerceRateLimitsForE2E = async (): Promise<void> => {
  assertE2ETestMode();
  await Promise.all([
    publicCommerceMutationStore.resetAll(),
    publicTenantLookupStore.resetAll(),
    publicConfigurationStore.resetAll(),
    publicCatalogueStore.resetAll(),
  ]);
};
