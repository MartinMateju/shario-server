import type { NextFunction, Request, Response } from "express";

import {
  AUTH_CONTEXT,
  type AuthContext,
} from "@/modules/auth/auth.constants.js";
import { forbidden, unauthorized } from "@/shared/http/httpErrors.js";

export const getRequestAuthContext = (req: Request): AuthContext => {
  const userInfo = (
    req as Request & {
      userInfo?: { authContext?: unknown };
    }
  ).userInfo;

  if (!userInfo) {
    unauthorized({
      message: "Authentication is required.",
      code: "AUTHENTICATION_REQUIRED",
    });
  }

  const value = userInfo.authContext;

  // Missing claims are accepted only as legacy workspace credentials.
  if (value === undefined || value === null || value === "") {
    return AUTH_CONTEXT.WORKSPACE;
  }

  if (
    value === AUTH_CONTEXT.WORKSPACE ||
    value === AUTH_CONTEXT.CUSTOMER
  ) {
    return value;
  }

  unauthorized({
    message: "The authentication context is invalid.",
    code: "AUTH_CONTEXT_INVALID",
  });

  // `unauthorized` throws. Keep an explicit typed fallback so the
  // production compiler does not widen `value` back to `unknown`.
  return AUTH_CONTEXT.WORKSPACE;
};

export const assertAuthContext = (
  req: Request,
  expected: AuthContext,
): void => {
  const actual = getRequestAuthContext(req);

  if (actual !== expected) {
    forbidden({
      message:
        expected === AUTH_CONTEXT.CUSTOMER
          ? "Sign in to the customer portal to continue."
          : "Workspace access is required.",
      code:
        expected === AUTH_CONTEXT.CUSTOMER
          ? "CUSTOMER_SESSION_REQUIRED"
          : "WORKSPACE_SESSION_REQUIRED",
    });
  }
};

const requireContext = (expected: AuthContext) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    assertAuthContext(req, expected);
    next();
  };

export const requireCustomerSession = requireContext(
  AUTH_CONTEXT.CUSTOMER,
);

export const requireWorkspaceSession = requireContext(
  AUTH_CONTEXT.WORKSPACE,
);
