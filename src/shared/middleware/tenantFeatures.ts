import type { NextFunction, Request, Response } from "express";

type TenantWithModules = {
  modules?: Record<string, boolean | undefined>;
  plan?: string;
};

type RequestWithTenant = Request & {
  tenant?: TenantWithModules | null;
};

export const tenantHasModule = (
  tenant: TenantWithModules | null | undefined,
  moduleName: string,
): boolean => {
  return Boolean(tenant?.modules?.[moduleName]);
};

export const requireTenantModule = (moduleName: string) => {
  return (
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

    if (!tenantHasModule(req.tenant, moduleName)) {
      res.status(403).json({
        message: `The "${moduleName}" module is not enabled for this tenant.`,
        requiredModule: moduleName,
        currentPlan: req.tenant.plan,
      });
      return;
    }

    next();
  };
};