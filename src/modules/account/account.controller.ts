import type { Response } from "express";

import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import {
  getAuthenticatedUserId,
  getRefreshCookieCleanupOptions,
} from "@/modules/auth/auth.utils.js";
import {
  CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from "@/modules/auth/auth.constants.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import {
  getCurrentAccount,
  updateCurrentAccountPassword,
  updateCurrentAccountProfile,
  updateCurrentCustomerPreferences,
} from "./account.service.js";
import {
  accountPasswordSchema,
  accountProfileSchema,
  customerPreferencesSchema,
} from "./account.validators.js";

export const getAccount = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const account = await getCurrentAccount({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
    });

    res.status(200).json({ account });
  },
);

export const updateAccountProfile = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const account = await updateCurrentAccountProfile({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      input: accountProfileSchema.parse(req.body),
    });

    res.status(200).json({ account });
  },
);

export const updateCustomerPreferences = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const account = await updateCurrentCustomerPreferences({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      input: customerPreferencesSchema.parse(req.body),
    });

    res.status(200).json({ account });
  },
);

export const updateAccountPassword = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await updateCurrentAccountPassword({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      input: accountPasswordSchema.parse(req.body),
    });

    for (const options of getRefreshCookieCleanupOptions(req.get("origin"))) {
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, options);
      res.clearCookie(CUSTOMER_REFRESH_TOKEN_COOKIE_NAME, options);
    }

    res.status(200).json({
      message: "Password updated. Please sign in again.",
    });
  },
);

