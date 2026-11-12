import { SETUP_PUBLICATION_STATUS } from "@/modules/setup-center/setup-center.constants.js";
import { SetupCenterStateModel } from "@/modules/setup-center/setup-center.model.js";
import { TENANT_STATUS } from "@/modules/tenants/tenant.constants.js";
import { getTenantBySlug } from "@/modules/tenants/services/tenant.service.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import type {
  TenantDocument,
  TenantId,
} from "@/modules/tenants/tenant.types.js";
import { notFound } from "@/shared/http/httpErrors.js";

const PUBLIC_WORKSPACE_NOT_FOUND = {
  message: "Workspace not found.",
  code: "PUBLIC_WORKSPACE_NOT_FOUND",
} as const;

const normalizeTenantSlug = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

/**
 * How long a resolved published-tenant lookup may be served from cache, and
 * the key it's cached under. Exported so the publish/unpublish write paths
 * in setup-center.service.ts can invalidate it precisely instead of waiting
 * out the TTL.
 */
export const PUBLIC_TENANT_CACHE_TTL_SECONDS = Number(
  process.env.PUBLIC_TENANT_CACHE_TTL_SECONDS || 30,
);

export const publicTenantCacheKey = (slug: string): string =>
  `shario:public-tenant:${normalizeTenantSlug(slug)}`;

export type TenantPublicationState = {
  status: (typeof SETUP_PUBLICATION_STATUS)[keyof typeof SETUP_PUBLICATION_STATUS];
  hasExplicitState: boolean;
};

/**
 * Authenticated diagnostics may distinguish a missing legacy state from an
 * explicit draft. Public lookups deliberately continue to collapse both into
 * the same generic 404.
 */
export const getTenantPublicationState = async (
  tenantId: TenantId,
): Promise<TenantPublicationState> => {
  const normalizedTenantId = String(tenantId ?? "").trim();
  const state = normalizedTenantId
    ? await SetupCenterStateModel.findOne({
        tenant: normalizedTenantId,
      })
        .select("publication.status")
        .lean()
    : null;
  const status =
    state?.publication?.status === SETUP_PUBLICATION_STATUS.LIVE
      ? SETUP_PUBLICATION_STATUS.LIVE
      : SETUP_PUBLICATION_STATUS.DRAFT;

  return {
    status,
    hasExplicitState: Boolean(state),
  };
};

/**
 * Publication is deny-by-default. A tenant is public only when it has an
 * explicit Setup Center state whose publication status is `live`.
 */
export const isTenantPublished = async (
  tenantId: TenantId | null | undefined,
): Promise<boolean> => {
  const normalizedTenantId = String(tenantId ?? "").trim();

  if (!normalizedTenantId) {
    return false;
  }

  const state = await SetupCenterStateModel.exists({
    tenant: normalizedTenantId,
    "publication.status": SETUP_PUBLICATION_STATUS.LIVE,
  });

  return Boolean(state);
};

const resolvePublishedTenantBySlug = async (
  normalizedTenantSlug: string,
): Promise<TenantDocument | null> => {
  const tenant = await getTenantBySlug(normalizedTenantSlug);

  if (
    !tenant ||
    tenant.status !== TENANT_STATUS.ACTIVE ||
    !(await isTenantPublished(tenant._id))
  ) {
    return null;
  }

  return tenant;
};

/**
 * Resolves an active, explicitly published tenant without revealing whether
 * the slug exists, is inactive, or is still a draft.
 *
 * Cached briefly: this is the public-route boundary for nearly every
 * customer-facing surface (booking, checkout, product catalog, membership,
 * AI concierge), so it resolves on almost every unauthenticated request.
 * Invalidated explicitly on publish/unpublish (setup-center.service.ts); the
 * short TTL bounds staleness for the rarer case of a platform-level tenant
 * status change elsewhere.
 * Configuration reads opt out so an in-flight stale cache fill cannot mask a
 * newly published snapshot or a changed publication state.
 *
 * Loaded dynamically so this public route boundary never requires
 * REDIS_URL to be configured just to resolve a tenant.
 */
export const findPublishedTenantBySlug = async (
  tenantSlug: string,
  options: { cache?: boolean } = {},
): Promise<TenantDocument | null> => {
  const normalizedTenantSlug = normalizeTenantSlug(tenantSlug);

  if (!normalizedTenantSlug) {
    return null;
  }

  if (options.cache === false) {
    return resolvePublishedTenantBySlug(normalizedTenantSlug);
  }

  const { getOrSetCache } = await import("@/infrastructure/redis/cache.js");
  const cached = await getOrSetCache(
    publicTenantCacheKey(normalizedTenantSlug),
    PUBLIC_TENANT_CACHE_TTL_SECONDS,
    async () => {
      const tenant = await resolvePublishedTenantBySlug(normalizedTenantSlug);
      return tenant ? tenant.toObject() : null;
    },
  );

  // Rehydrate into a real Mongoose document so downstream consumers of
  // req.tenant keep working exactly as they do on a cache miss (virtuals,
  // schema getters/defaults, instanceof checks all behave the same as a
  // freshly-queried document).
  return cached ? TenantModel.hydrate(cached) : null;
};

export const requirePublishedTenantBySlug = async (
  tenantSlug: string,
): Promise<TenantDocument> => {
  const tenant = await findPublishedTenantBySlug(tenantSlug);

  if (!tenant) {
    notFound(PUBLIC_WORKSPACE_NOT_FOUND);
  }

  return tenant;
};

export const requirePublishedTenantId = async (
  tenantId: TenantId | null | undefined,
): Promise<void> => {
  if (!(await isTenantPublished(tenantId))) {
    notFound(PUBLIC_WORKSPACE_NOT_FOUND);
  }
};
