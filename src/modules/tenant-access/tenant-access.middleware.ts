import type { NextFunction, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import { assertAuthContext } from "@/modules/auth/middleware/requireAuthContext.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { badRequest, forbidden, notFound } from "@/shared/http/httpErrors.js";

import {
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ACCESS_CACHE_TTL_SECONDS,
  workspaceAccessCacheKey,
} from "./tenant-access.constants.js";
import {
  isWorkspacePermission,
  type WorkspacePermission,
} from "./tenant-access.permissions.js";
import type {
  ResolvedWorkspaceAccess,
  WorkspaceAccessRequest,
} from "./tenant-access.types.js";
import {
  canAccessWorkspaceLocation,
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "./services/authorization.service.js";

export type WorkspaceLocationIdResolver = (
  req: WorkspaceAccessRequest,
) => unknown | Promise<unknown>;

const resolveRequestWorkspaceAccess = async (
  req: WorkspaceAccessRequest,
): Promise<ResolvedWorkspaceAccess | null> => {
  // A customer-mode token must never be reinterpreted as its underlying
  // owner/staff database membership.
  assertAuthContext(req, AUTH_CONTEXT.WORKSPACE);

  if (req.workspaceAccessResolved) {
    return req.workspaceAccess ?? null;
  }

  const tenantId = requireTenantId(req);
  const userId = getAuthenticatedUserId(req);

  /*
   * Platform roles deliberately do not bypass tenant authorization. Internal
   * admin.shario.io access requires separate audited routes or an explicit
   * impersonation session rather than silently inheriting owner permissions.
   *
   * Cached briefly: this resolves on nearly every authenticated request, and
   * the underlying membership document only changes on explicit role/status/
   * location-access writes (invalidated in tenant-access.repository.ts) or a
   * custom role definition edit (also invalidated there). The short TTL
   * bounds staleness even if an invalidation path is missed.
   *
   * Loaded dynamically so this middleware (imported by nearly every route)
   * never requires REDIS_URL to be configured just to resolve access.
   */
  const { getOrSetCache } = await import("@/infrastructure/redis/cache.js");
  const access = await getOrSetCache(
    workspaceAccessCacheKey(tenantId, userId),
    WORKSPACE_ACCESS_CACHE_TTL_SECONDS,
    () => resolveWorkspaceAccessForUser({ tenantId, userId }),
  );

  req.workspaceAccess = access;
  req.workspaceAccessResolved = true;

  return access;
};

const requireActiveAccess = (
  access: ResolvedWorkspaceAccess | null,
): ResolvedWorkspaceAccess => {
  if (!access) {
    forbidden({
      message: "Workspace access is required.",
      code: "WORKSPACE_ACCESS_REQUIRED",
    });
  }

  if (access.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE) {
    forbidden({
      message: "Workspace access is not active.",
      code: "WORKSPACE_ACCESS_INACTIVE",
      details: { status: access.status },
    });
  }

  return access;
};

export const requireWorkspaceAccess = async (
  req: WorkspaceAccessRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    requireActiveAccess(await resolveRequestWorkspaceAccess(req));
    next();
  } catch (error) {
    next(error);
  }
};

const assertKnownPermissions = (
  permissions: readonly WorkspacePermission[],
): void => {
  if (!permissions.length) {
    throw new Error("At least one workspace permission is required.");
  }

  for (const permission of permissions) {
    if (!isWorkspacePermission(permission)) {
      throw new Error(`Unknown workspace permission: ${permission}`);
    }
  }
};

export const requirePermission = (...permissions: WorkspacePermission[]) => {
  assertKnownPermissions(permissions);

  return async (
    req: WorkspaceAccessRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const access = requireActiveAccess(
        await resolveRequestWorkspaceAccess(req),
      );

      const missingPermissions = permissions.filter(
        (permission) => !hasWorkspacePermission(access, permission),
      );

      if (missingPermissions.length) {
        forbidden({
          message: "You do not have permission to perform this action.",
          code: "WORKSPACE_PERMISSION_REQUIRED",
          details: { requiredPermissions: permissions },
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export const requireAnyPermission = (...permissions: WorkspacePermission[]) => {
  assertKnownPermissions(permissions);

  return async (
    req: WorkspaceAccessRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const access = requireActiveAccess(
        await resolveRequestWorkspaceAccess(req),
      );

      const isAllowed = permissions.some((permission) =>
        hasWorkspacePermission(access, permission),
      );

      if (!isAllowed) {
        forbidden({
          message: "You do not have permission to perform this action.",
          code: "ANY_WORKSPACE_PERMISSION_REQUIRED",
          details: { acceptedPermissions: permissions },
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Enforces the current member's assigned-location scope for a single-resource
 * route. A 404 is used for an unassigned location so the endpoint does not
 * reveal whether a resource exists outside the member's scope.
 *
 * @example
 * router.get(
 *   "/locations/:locationId/bookings",
 *   requireLocationAccess((req) => req.params.locationId),
 *   listBookings,
 * );
 */
export const requireLocationAccess = (
  resolveLocationId: WorkspaceLocationIdResolver,
) => {
  if (typeof resolveLocationId !== "function") {
    throw new Error("A workspace location id resolver is required.");
  }

  return async (
    req: WorkspaceAccessRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const access = requireActiveAccess(
        await resolveRequestWorkspaceAccess(req),
      );
      const rawLocationId = await resolveLocationId(req);
      const locationId =
        typeof rawLocationId === "string"
          ? rawLocationId.trim()
          : String(rawLocationId ?? "").trim();

      if (!locationId) {
        badRequest({
          message: "A location identifier is required.",
          code: "WORKSPACE_LOCATION_REQUIRED",
        });
      }

      if (!canAccessWorkspaceLocation(access, locationId)) {
        notFound({
          message: "Location not found.",
          code: "WORKSPACE_LOCATION_NOT_FOUND",
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export const getResolvedWorkspaceAccess = (
  req: WorkspaceAccessRequest,
): ResolvedWorkspaceAccess => {
  return requireActiveAccess(req.workspaceAccess ?? null);
};
