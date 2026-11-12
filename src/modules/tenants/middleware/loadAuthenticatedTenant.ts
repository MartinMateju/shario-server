import type { NextFunction, Response } from "express";

import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import { getTenantOrThrow } from "../services/tenant.service.js";
import { requireTenantId } from "../tenant.utils.js";

/** Hydrate feature context after authentication, without adding a billing gate. */
export const loadAuthenticatedTenant = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // The verified principal determines the tenant, never a hostname or query.
    req.tenant = await getTenantOrThrow(requireTenantId(req));
    next();
  } catch (error) {
    next(error);
  }
};
