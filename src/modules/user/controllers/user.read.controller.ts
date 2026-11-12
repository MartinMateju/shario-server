import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { badRequest } from "../../../shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { assertValidObjectId } from "../user.validators.js";
import { TENANT_ROLE } from "../user.constants.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";
import {
  getCustomerById as getCustomerByIdService,
  getUserByCustomIdOrContact,
  listUsers,
  listUsersWithFilters,
  lookupUser as lookupUserService,
} from "../services/user.read.service.js";

const normalizeParamValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.join(",");
  }

  return String(value || "").trim();
};

export const getCustomerById = asyncHandler(
  async (req: Request, res: Response) => {
    const customerId = normalizeParamValue(req.params.id);
    assertValidObjectId(customerId, "Invalid customer id");

    const customer = await getCustomerByIdService({
      tenantId: requireTenantId(req),
      customerId,
    });

    res.json({ customer });
  },
);

export const getAllUsers = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const tenantRole = req.query.tenantRole;

  if (tenantRole !== undefined && tenantRole !== TENANT_ROLE.CUSTOMER) {
    badRequest("Invalid customer list scope.");
  }

  const users = await listUsers({
    tenantId,
    access: getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
    tenantRole:
      tenantRole === TENANT_ROLE.CUSTOMER ? TENANT_ROLE.CUSTOMER : undefined,
  });

  res.json(users);
});

export const getUserbyCustomId = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const customId = normalizeParamValue(req.params.customId);

    if (!customId) {
      badRequest("Missing customId");
    }

    const users = await getUserByCustomIdOrContact({
      tenantId,
      value: customId,
    });

    res.json(users);
  },
);

export const getUsersWithFilters = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);

    const result = await listUsersWithFilters({
      tenantId,
      input: req.body,
      access: getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
    });

    res.json(result);
  },
);

export const lookupUser = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const search = normalizeParamValue(req.query.search);

  if (!search) {
    badRequest("Missing search query.");
  }

  const user = await lookupUserService({
    tenantId,
    search,
  });

  res.json(user);
});
