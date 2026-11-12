import type { NextFunction, Request, Response } from "express";

import { findActiveTenantByHostname } from "@/modules/tenants/tenant.repository.js";

const PLATFORM_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "shario.io",
  "www.shario.io",
  "app.shario.io",
  "admin.shario.io",
]);

type RequestWithTenant = Request & {
  hostnameNormalized?: string;
  tenant?: unknown | null;
};

const normalizeHost = (host?: string | string[]): string => {
  const value = Array.isArray(host) ? host[0] : host;

  return String(value || "")
    .split(":")[0]
    .toLowerCase()
    .trim();
};

export const resolveTenant = async (
  req: RequestWithTenant,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const hostname = normalizeHost(req.headers.host);

    req.hostnameNormalized = hostname;
    req.tenant = null;

    if (!hostname || PLATFORM_HOSTS.has(hostname)) {
      next();
      return;
    }

    const tenant = await findActiveTenantByHostname(hostname);

    if (!tenant) {
      res.status(404).json({
        message: "Tenant not found for this domain.",
      });
      return;
    }

    req.tenant = tenant;

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
