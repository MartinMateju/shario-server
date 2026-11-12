import type { NextFunction, Request, Response } from "express";

import { forbidden, unauthorized } from "../../../shared/http/httpErrors.js";
import type { AccessTokenPayload } from "../auth.types.js";

type RequestWithUserInfo = Request & {
  userInfo?: AccessTokenPayload["UserInfo"];
};

export const verifyRoles = (...allowedRoles: string[]) => {
  return (
    req: RequestWithUserInfo,
    _res: Response,
    next: NextFunction,
  ): void => {
    if (!req.userInfo) {
      unauthorized("Authentication is required.");
    }

    const tenantRole = String(req.userInfo.tenantRole || "").toLowerCase();
    const platformRole = String(req.userInfo.platformRole || "").toLowerCase();
    const normalizedAllowedRoles = allowedRoles.map((role) => role.toLowerCase());

    const hasRole =
      normalizedAllowedRoles.includes(tenantRole) ||
      normalizedAllowedRoles.includes(platformRole);

    if (!hasRole) {
      forbidden("You don't have permission to perform this action.");
    }

    next();
  };
};
