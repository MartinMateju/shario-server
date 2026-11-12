import type { NextFunction, Request, Response } from "express";

import { findTenantById } from "@/modules/tenants/tenant.repository.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { notFound } from "@/shared/http/httpErrors.js";

export const loadMembershipTenant = async (
  req: Request & { tenant?: unknown },
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const tenant = await findTenantById(requireTenantId(req));
    if (!tenant) notFound("Workspace not found.");
    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
};

