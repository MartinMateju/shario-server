import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";

import { supplyOrderService } from "../services/supply-order.service.js";
import {
  createSupplyOrderSchema,
  listSupplyOrdersSchema,
  supplyOrderIdParamsSchema,
  updateSupplyOrderSchema,
} from "../supply-order.validators.js";

const getAllowedLocationIds = (req: Request) =>
  getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  );

export const getSupplyOrders = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = listSupplyOrdersSchema.parse(req.query);

    const result = await supplyOrderService.list(
      tenantId,
      input,
      getAllowedLocationIds(req),
    );

    res.json(result);
  },
);

export const getSupplyOrderById = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = supplyOrderIdParamsSchema.parse(req.params);

    const order = await supplyOrderService.getById(
      tenantId,
      id,
      getAllowedLocationIds(req),
    );

    res.json(order);
  },
);

export const createSupplyOrder = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createSupplyOrderSchema.parse(req.body);

    const order = await supplyOrderService.create(
      tenantId,
      createdBy,
      input,
      getAllowedLocationIds(req),
    );

    res.status(201).json(order);
  },
);

export const updateSupplyOrder = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = supplyOrderIdParamsSchema.parse(req.params);
    const input = updateSupplyOrderSchema.parse(req.body);

    const order = await supplyOrderService.update(
      tenantId,
      id,
      input,
      getAllowedLocationIds(req),
    );

    res.json(order);
  },
);

export const deleteSupplyOrder = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = supplyOrderIdParamsSchema.parse(req.params);

    const result = await supplyOrderService.delete(
      tenantId,
      id,
      getAllowedLocationIds(req),
    );

    res.json(result);
  },
);
