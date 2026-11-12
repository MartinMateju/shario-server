import type { NextFunction, Response } from "express";

import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { forbidden } from "@/shared/http/httpErrors.js";

import { getTenantSubscriptionAccess } from "../services/tenant-subscription.service.js";

/**
 * Apply this after verifyJWT on tenant feature routes. Billing, onboarding,
 * authentication and data-export routes should remain outside this guard.
 */
export const requireTenantSubscriptionAccess = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const tenantId = requireTenantId(req);
    const { tenant, access } =
      await getTenantSubscriptionAccess(tenantId);

    if (!access.canUseFeatures) {
      forbidden({
        message: "An active tenant subscription is required.",
        code: "TENANT_SUBSCRIPTION_REQUIRED",
        details: access,
      });
    }

    /*
     * Downstream feature-module guards need the authoritative tenant
     * document. Hydrate it here once, using the same tenant ID whose
     * subscription was checked, rather than trusting the request hostname.
     */
    req.tenant = tenant;

    next();
  } catch (error) {
    next(error);
  }
};
