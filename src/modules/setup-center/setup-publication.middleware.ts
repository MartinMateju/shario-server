import type { NextFunction, Request, Response } from "express";

import { TENANT_SLUG_REGEX } from "@/modules/tenants/tenant.validators.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";

import { findPublishedTenantBySlug } from "./setup-publication.service.js";

export type PublishedTenantRequest = Request & {
  tenant?: TenantDocument | null;
  tenantId?: string;
};

const normalizeTenantSlug = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const isValidTenantSlug = (tenantSlug: string): boolean =>
  tenantSlug.length >= 2 &&
  tenantSlug.length <= 80 &&
  TENANT_SLUG_REGEX.test(tenantSlug);

/**
 * Public-route boundary for tenant surfaces. Draft, inactive and unknown
 * workspaces deliberately receive the same response.
 */
const loadPublishedTenantWithLookup = async (
  req: PublishedTenantRequest,
  res: Response,
  next: NextFunction,
  findTenant: (slug: string) => Promise<TenantDocument | null>,
): Promise<void> => {
  try {
    const tenantSlug = normalizeTenantSlug(req.params.tenantSlug);

    if (!isValidTenantSlug(tenantSlug)) {
      res.status(404).json({
        message: "Workspace not found.",
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      });
      return;
    }

    const tenant = await findTenant(tenantSlug);

    if (!tenant) {
      res.status(404).json({
        message: "Workspace not found.",
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      });
      return;
    }

    req.params.tenantSlug = tenantSlug;
    req.tenant = tenant;
    req.tenantId = String(tenant._id);

    next();
  } catch (error) {
    next(error);
  }
};

export const loadPublishedTenant = (
  req: PublishedTenantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> =>
  loadPublishedTenantWithLookup(req, res, next, findPublishedTenantBySlug);

// Published configuration must bypass cached tenant snapshots, including any
// stale cache fill that finishes after publication invalidates the cache.
export const loadFreshPublishedTenant = (
  req: PublishedTenantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> =>
  loadPublishedTenantWithLookup(req, res, next, (tenantSlug) =>
    findPublishedTenantBySlug(tenantSlug, { cache: false }),
  );
