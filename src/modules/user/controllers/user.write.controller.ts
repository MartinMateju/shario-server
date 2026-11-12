import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  getAuthenticatedUserId,
  getRefreshCookieCleanupOptions,
} from "@/modules/auth/auth.utils.js";
import {
  CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from "@/modules/auth/auth.constants.js";
import {
  createUser,
  deleteUser as deleteUserService,
  updateUser as updateUserService,
  updateUserPassword as updateUserPasswordService,
} from "../services/user.write.service.js";

export const createNewUser = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);

    const result = await createUser({
      tenantId,
      input: req.body,
    });

    res.status(201).json(result);
  },
);

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);

  const result = await updateUserService({
    tenantId,
    input: req.body,
  });

  res.json(result);
});

export const updateUserPassword = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);

    const result = await updateUserPasswordService({
      tenantId,
      input: {
        ...req.body,
        id: getAuthenticatedUserId(req),
      },
    });

    for (const options of getRefreshCookieCleanupOptions(req.get("origin"))) {
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, options);
      res.clearCookie(CUSTOMER_REFRESH_TOKEN_COOKIE_NAME, options);
    }

    res.json(result);
  },
);

export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);

  const result = await deleteUserService({
    tenantId,
    id: req.body.id,
  });

  res.json(result);
});
