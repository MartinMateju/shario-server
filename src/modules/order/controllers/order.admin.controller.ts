import type { Request, Response } from "express";

import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  getOrderById as getOrderByIdService,
  getOrdersWithFilters as getOrdersWithFiltersService,
} from "@/modules/order/services/order.admin.service.js";
import { getAllowedWorkspaceLocationIds } from "@/modules/tenant-access/services/authorization.service.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";

const allowedLocations = (req: Request) =>
  getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  );

const listOrders = (input: (req: Request) => unknown) =>
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await getOrdersWithFiltersService({
      tenantId: requireTenantId(req),
      input: input(req),
      allowedLocationIds: allowedLocations(req),
    });

    res.status(200).json(result);
  });

export const listAdminOrders = listOrders((req) => req.query);

export const getOrdersWithFilters = listOrders((req) => req.body);

export const getAdminOrder = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const order = await getOrderByIdService({
      tenantId: requireTenantId(req),
      orderId: String(req.params.id ?? ""),
      allowedLocationIds: allowedLocations(req),
    });

    res.status(200).json({ order });
  },
);
