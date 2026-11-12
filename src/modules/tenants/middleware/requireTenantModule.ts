import type { NextFunction, Response } from "express";

import { TENANT_MODULE } from "../tenant.constants.js";
import type { RequestWithTenant, TenantModuleName } from "../tenant.types.js";
import { getTenantModuleEntitlements } from "../tenant-workspace-modules.js";
import { tenantHasModule } from "@/shared/middleware/tenantFeatures.js";

export const requireTenantModule = (moduleName: TenantModuleName) => {
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

    const entitled = getTenantModuleEntitlements({
      plan: req.tenant.plan,
      planVersion: req.tenant.planVersion,
    })[moduleName];
    const legacyImplicitAccess =
      moduleName === TENANT_MODULE.ACCESS_CODES &&
      Number(req.tenant.planVersion ?? 1) < 3 &&
      req.tenant.modules?.[moduleName] === undefined &&
      req.tenant.workspaceModules?.[moduleName]?.selected !== false;

    if (moduleName === TENANT_MODULE.FIRING || (!tenantHasModule(req.tenant, moduleName) && !legacyImplicitAccess)) {
      const code = entitled
        ? "TENANT_MODULE_DISABLED"
        : "TENANT_MODULE_NOT_ENTITLED";
      res.status(403).json({
        message: entitled
          ? `The "${moduleName}" module is disabled for this workspace.`
          : `The "${moduleName}" module is not included in the current plan.`,
        code,
        details: { module: moduleName, currentPlan: req.tenant.plan },
        // Compatibility fields for existing API consumers.
        requiredModule: moduleName,
        currentPlan: req.tenant.plan,
      });
      return;
    }

    next();
  };
};

export const requireAnyTenantModule = (
  moduleNames: readonly TenantModuleName[],
) => {
  return (
    req: RequestWithTenant,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!req.tenant) {
      res.status(400).json({ message: "Tenant context is required." });
      return;
    }

    if (moduleNames.some((moduleName) => moduleName !== TENANT_MODULE.FIRING && tenantHasModule(req.tenant, moduleName))) {
      next();
      return;
    }

    const entitlements = getTenantModuleEntitlements({
      plan: req.tenant.plan,
      planVersion: req.tenant.planVersion,
    });
    const hasEntitledOption = moduleNames.some(
      (moduleName) => entitlements[moduleName],
    );
    const code = hasEntitledOption
      ? "TENANT_MODULE_DISABLED"
      : "TENANT_MODULE_NOT_ENTITLED";
    res.status(403).json({
      message: hasEntitledOption
        ? "A required workspace capability is disabled."
        : "None of the required capabilities is included in the current plan.",
      code,
      details: {
        modules: [...moduleNames],
        currentPlan: req.tenant.plan,
      },
      requiredModules: [...moduleNames],
      currentPlan: req.tenant.plan,
    });
  };
};
