import type { NextFunction, Request, Response } from "express";

import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import {
  requireAnyTenantModule,
  requireTenantModule,
} from "@/modules/tenants/middleware/requireTenantModule.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import {
  DATA_IMPORT_ENTITY,
  type DataImportEntity,
} from "./data-import.constants.js";
import { assertCommerceImportReady } from "./services/commerce-import-readiness.service.js";
import { getTenantImportSession } from "./services/data-import.service.js";

const entityConfig = {
  [DATA_IMPORT_ENTITY.CUSTOMERS]: {
    permission: WORKSPACE_PERMISSION.CUSTOMERS_IMPORT,
    rollbackPermissions: [WORKSPACE_PERMISSION.CUSTOMERS_MANAGE],
    modules: [TENANT_MODULE.CUSTOMERS],
  },
  [DATA_IMPORT_ENTITY.PRODUCTS]: {
    permission: WORKSPACE_PERMISSION.PRODUCTS_IMPORT,
    rollbackPermissions: [WORKSPACE_PERMISSION.PRODUCTS_MANAGE],
    modules: [TENANT_MODULE.BOOKINGS, TENANT_MODULE.COURSES],
  },
  [DATA_IMPORT_ENTITY.BOOKINGS]: {
    permission: WORKSPACE_PERMISSION.BOOKINGS_IMPORT,
    rollbackPermissions: [
      WORKSPACE_PERMISSION.BOOKINGS_CANCEL,
      WORKSPACE_PERMISSION.BOOKINGS_UPDATE,
    ],
    modules: [TENANT_MODULE.BOOKINGS],
  },
  [DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS]: {
    permission: WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
    rollbackPermissions: [WORKSPACE_PERMISSION.MEMBERSHIPS_MANAGE],
    modules: [TENANT_MODULE.MEMBERSHIPS],
  },
  [DATA_IMPORT_ENTITY.MEMBERSHIPS]: {
    permission: WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
    rollbackPermissions: [WORKSPACE_PERMISSION.MEMBERSHIPS_MANAGE],
    modules: [TENANT_MODULE.MEMBERSHIPS],
  },
  [DATA_IMPORT_ENTITY.CREDITS]: {
    permission: WORKSPACE_PERMISSION.CREDITS_IMPORT,
    rollbackPermissions: [WORKSPACE_PERMISSION.CREDITS_MANAGE],
    modules: [TENANT_MODULE.CREDITS],
  },
  [DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS]: {
    permission: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
    rollbackPermissions: [WORKSPACE_PERMISSION.VOUCHERS_MANAGE],
    modules: [TENANT_MODULE.VOUCHERS],
  },
  [DATA_IMPORT_ENTITY.VOUCHERS]: {
    permission: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
    rollbackPermissions: [WORKSPACE_PERMISSION.VOUCHERS_MANAGE],
    modules: [TENANT_MODULE.VOUCHERS],
  },
} as const;

const asEntity = (value: unknown): DataImportEntity => {
  const normalized = String(value || DATA_IMPORT_ENTITY.CUSTOMERS);
  if (
    !Object.values(DATA_IMPORT_ENTITY).includes(normalized as DataImportEntity)
  ) {
    badRequest({
      message: "Import entity type is invalid.",
      code: "IMPORT_ENTITY_INVALID",
    });
  }
  return normalized as DataImportEntity;
};

const runEntityAccess = (
  entityType: DataImportEntity,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const config = entityConfig[entityType];
  const moduleMiddleware =
    config.modules.length === 1
      ? requireTenantModule(config.modules[0])
      : requireAnyTenantModule(config.modules);
  moduleMiddleware(req as never, res, (moduleError?: unknown) => {
    if (moduleError) {
      next(moduleError);
      return;
    }
    void requirePermission(config.permission)(req as never, res, next);
  });
};

const runRollbackAccess = (
  entityType: DataImportEntity,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const config = entityConfig[entityType];
  const moduleMiddleware =
    config.modules.length === 1
      ? requireTenantModule(config.modules[0])
      : requireAnyTenantModule(config.modules);
  moduleMiddleware(req as never, res, (moduleError?: unknown) => {
    if (moduleError) {
      next(moduleError);
      return;
    }
    void requirePermission(
      config.permission,
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      ...config.rollbackPermissions,
    )(req as never, res, next);
  });
};

export const requireStaticImportAccess =
  (entityType: DataImportEntity) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await assertCommerceImportReady(entityType);
      runEntityAccess(entityType, req, res, next);
    } catch (error) {
      next(error);
    }
  };

export const requireImportListAccess = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const entityType = asEntity(req.query.entity ?? req.query.entityType);
    await assertCommerceImportReady(entityType);
    runEntityAccess(entityType, req, res, next);
  } catch (error) {
    next(error);
  }
};

export const requireImportSessionAccess = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id)
      badRequest({
        message: "Import session id is required.",
        code: "IMPORT_ID_REQUIRED",
      });
    const session = await getTenantImportSession({
      tenantId: requireTenantId(req),
      sessionId: id,
    });
    const entityType = asEntity(session.entityType);
    await assertCommerceImportReady(entityType);
    (req as Request & { dataImportSession?: unknown }).dataImportSession =
      session;
    runEntityAccess(entityType, req, res, next);
  } catch (error) {
    next(error);
  }
};

export const requireImportRollbackAccess = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id)
      badRequest({
        message: "Import session id is required.",
        code: "IMPORT_ID_REQUIRED",
      });
    const session = await getTenantImportSession({
      tenantId: requireTenantId(req),
      sessionId: id,
    });
    const entityType = asEntity(session.entityType);
    await assertCommerceImportReady(entityType);
    (req as Request & { dataImportSession?: unknown }).dataImportSession =
      session;
    runRollbackAccess(entityType, req, res, next);
  } catch (error) {
    next(error);
  }
};
