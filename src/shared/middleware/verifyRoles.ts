import type { NextFunction, Request, Response } from "express";

import { logger } from "../../config/logger.js";

export const TENANT_ROLE = {
  OWNER: "owner",
  ADMIN: "admin",
  STAFF: "staff",
  CUSTOMER: "customer",
} as const;

export const PLATFORM_ROLE = {
  NONE: "none",
  SUPER_ADMIN: "super_admin",
  SUPPORT: "support",
  DEVELOPER: "developer",
} as const;

export type TenantRole = (typeof TENANT_ROLE)[keyof typeof TENANT_ROLE];
export type PlatformRole = (typeof PLATFORM_ROLE)[keyof typeof PLATFORM_ROLE];

export type AuthUserInfo = {
  id?: string;
  email?: string;
  tenant?: string;
  tenantRole?: TenantRole;
  platformRole?: PlatformRole;
  roles?: string[];
  isAdmin?: boolean;
  isModerator?: boolean;
  isAccessGranted?: boolean;
};

type AuthenticatedRequest = Request & {
  userInfo?: AuthUserInfo;
};

type VerifyRolesOptions = {
  tenantRoles?: TenantRole[];
  platformRoles?: PlatformRole[];
  legacyRoles?: string[];
  allowPlatformAdmin?: boolean;
};

const hasAllowedRole = <T extends string>(
  currentRole: T | undefined,
  allowedRoles?: T[],
): boolean => {
  if (!allowedRoles?.length) return false;
  if (!currentRole) return false;

  return allowedRoles.includes(currentRole);
};

const hasLegacyRole = (
  userRoles: string[] | undefined,
  allowedRoles?: string[],
): boolean => {
  if (!allowedRoles?.length) return false;
  if (!userRoles?.length) return false;

  return allowedRoles.some((role) => userRoles.includes(role));
};

const normalizeOptions = (
  optionsOrRoles?: VerifyRolesOptions | TenantRole | string,
  roles: string[] = [],
): VerifyRolesOptions => {
  if (!optionsOrRoles) return {};

  if (typeof optionsOrRoles === "object") {
    return optionsOrRoles;
  }

  return {
    legacyRoles: [optionsOrRoles, ...roles].filter(Boolean),
  };
};

const verifyRoles = (
  optionsOrRole?: VerifyRolesOptions | TenantRole | string,
  ...legacyRoles: string[]
) => {
  const options = normalizeOptions(optionsOrRole, legacyRoles);

  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    const userInfo = req.userInfo;

    if (!userInfo) {
      logger.warn("[AUTH] verifyRoles called without req.userInfo");

      res.status(401).json({
        code: "AUTH_REQUIRED",
        message: "Authentication required",
      });
      return;
    }

    if (userInfo.isAccessGranted === false) {
      logger.warn(
        { userId: userInfo.id, email: userInfo.email },
        "[AUTH] Access denied because user access is disabled",
      );

      res.status(403).json({
        code: "ACCESS_DISABLED",
        message: "User access is disabled",
      });
      return;
    }

    const allowPlatformAdmin = options.allowPlatformAdmin ?? true;

    const isPlatformAdmin =
      userInfo.platformRole === PLATFORM_ROLE.SUPER_ADMIN ||
      userInfo.platformRole === PLATFORM_ROLE.DEVELOPER;

    if (allowPlatformAdmin && isPlatformAdmin) {
      next();
      return;
    }

    const allowed =
      hasAllowedRole(userInfo.tenantRole, options.tenantRoles) ||
      hasAllowedRole(userInfo.platformRole, options.platformRoles) ||
      hasLegacyRole(userInfo.roles, options.legacyRoles) ||
      Boolean(
        userInfo.isAdmin &&
        options.legacyRoles?.some((role) =>
          ["admin", "9092k"].includes(role),
        ),
      );

    if (!allowed) {
      logger.warn(
        {
          userId: userInfo.id,
          email: userInfo.email,
          tenantRole: userInfo.tenantRole,
          platformRole: userInfo.platformRole,
          required: options,
        },
        "[AUTH] Insufficient permissions",
      );

      res.status(403).json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Insufficient permissions",
      });
      return;
    }

    next();
  };
};

export default verifyRoles;