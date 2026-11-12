import type { NextFunction, Request, Response } from "express";

type RequestWithUserInfo = Request & {
  userInfo?: {
    tenantRole?: string;
    platformRole?: string;
    isAdmin?: boolean;
    isModerator?: boolean;
  };
};

const PRODUCT_MANAGER_TENANT_ROLES = new Set(["owner", "admin", "manager"]);
const PRODUCT_MANAGER_PLATFORM_ROLES = new Set(["owner", "admin", "super_admin"]);

export const requireProductManager = (
  req: RequestWithUserInfo,
  res: Response,
  next: NextFunction,
): void => {
  const userInfo = req.userInfo;

  const hasTenantAccess = userInfo?.tenantRole
    ? PRODUCT_MANAGER_TENANT_ROLES.has(userInfo.tenantRole)
    : false;

  const hasPlatformAccess = userInfo?.platformRole
    ? PRODUCT_MANAGER_PLATFORM_ROLES.has(userInfo.platformRole)
    : false;

  if (!userInfo?.isAdmin && !hasTenantAccess && !hasPlatformAccess) {
    res.status(403).json({
      message: "You do not have permission to manage products.",
    });
    return;
  }

  next();
};
