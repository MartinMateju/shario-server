import type { NextFunction, Response } from "express";

import { logger } from "../../../config/logger.js";
import { getTenantByHostname } from "../services/tenant.service.js";
import type { RequestWithTenant } from "../tenant.types.js";
import { isPlatformHost, normalizeHost } from "../tenant.utils.js";

export const resolveTenant = async (
  req: RequestWithTenant,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const hostname = normalizeHost(req.headers.host);

    req.hostnameNormalized = hostname;
    req.tenant = null;

    if (isPlatformHost(hostname)) {
      next();
      return;
    }

    const tenant = await getTenantByHostname(hostname);

    if (!tenant) {
      logger.warn({ hostname }, "Tenant not found for hostname.");
      res.status(404).json({
        message: "Tenant not found for this domain.",
      });
      return;
    }

    req.tenant = tenant;
    req.tenantId = tenant._id.toString();

    next();
  } catch (error) {
    next(error);
  }
};

export const requireTenant = (
  req: RequestWithTenant,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.tenant) {
    res.status(400).json({
      message: "Tenant context is required.",
    });
    return;
  }

  next();
};
