import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";

import { inventoryService } from "../services/inventory.service.js";
import {
  createInventoryAuditSchema,
  createInventoryItemSchema,
  createInventoryMovementSchema,
  createReorderRequestSchema,
  idParamsSchema,
  listInventoryAuditsSchema,
  listInventoryItemsSchema,
  listInventoryMovementsSchema,
  listReorderRequestsSchema,
  receiveReorderRequestSchema,
  updateInventoryAuditSchema,
  updateInventoryItemSchema,
  updateReorderRequestSchema,
} from "../inventory.validators.js";

const getAllowedLocationIds = (req: Request) =>
  getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  );

const paginationResponse = <T>(
  key: string,
  data: T[],
  total: number,
  page: number,
  limit: number,
) => ({
  [key]: data,
  total,
  page,
  pages: Math.ceil(total / limit),
});

export const getInventoryItems = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listInventoryItemsSchema.parse(req.query);

    const { items, total } = await inventoryService.listItems({
      tenantId,
      ...filters,
      allowedLocationIds: getAllowedLocationIds(req),
    });

    res.json(
      paginationResponse("items", items, total, filters.page, filters.limit),
    );
  },
);

export const getInventoryItem = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = idParamsSchema.parse(req.params);

    const item = await inventoryService.getItem(
      tenantId,
      id,
      getAllowedLocationIds(req),
    );

    res.json(item);
  },
);

export const createInventoryItem = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createInventoryItemSchema.parse(req.body);

    const item = await inventoryService.createItem(
      tenantId,
      createdBy,
      input,
      getAllowedLocationIds(req),
    );

    res.status(201).json(item);
  },
);

export const updateInventoryItem = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = idParamsSchema.parse(req.params);
    const updatedBy = getAuthenticatedUserId(req);
    const input = updateInventoryItemSchema.parse(req.body);

    const item = await inventoryService.updateItem(
      tenantId,
      id,
      updatedBy,
      input,
      getAllowedLocationIds(req),
    );

    res.json(item);
  },
);

export const createInventoryMovement = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createInventoryMovementSchema.parse(req.body);

    const movement = await inventoryService.createMovement(
      tenantId,
      createdBy,
      input,
      getAllowedLocationIds(req),
    );

    res.status(201).json(movement);
  },
);

export const getInventoryMovements = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listInventoryMovementsSchema.parse(req.query);

    const { movements, total } = await inventoryService.listMovements({
      tenantId,
      ...filters,
      allowedLocationIds: getAllowedLocationIds(req),
    });

    res.json(
      paginationResponse(
        "movements",
        movements,
        total,
        filters.page,
        filters.limit,
      ),
    );
  },
);

export const createInventoryAudit = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createInventoryAuditSchema.parse(req.body);

    const audit = await inventoryService.createAudit(
      tenantId,
      createdBy,
      input,
      getAllowedLocationIds(req),
    );

    res.status(201).json(audit);
  },
);

export const getInventoryAudits = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listInventoryAuditsSchema.parse(req.query);

    const { audits, total } = await inventoryService.listAudits(
      tenantId,
      { ...filters, allowedLocationIds: getAllowedLocationIds(req) },
    );

    res.json(
      paginationResponse("audits", audits, total, filters.page, filters.limit),
    );
  },
);

export const updateInventoryAudit = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = idParamsSchema.parse(req.params);
    const input = updateInventoryAuditSchema.parse(req.body);

    const audit = await inventoryService.updateAudit(
      tenantId,
      id,
      input,
      getAllowedLocationIds(req),
    );

    res.json(audit);
  },
);

export const completeInventoryAudit = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = idParamsSchema.parse(req.params);
    const completedBy = getAuthenticatedUserId(req);

    const audit = await inventoryService.completeAudit(
      tenantId,
      id,
      completedBy,
      getAllowedLocationIds(req),
    );

    res.json({
      message: "Audit completed successfully.",
      audit,
    });
  },
);

export const getReorderRequests = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listReorderRequestsSchema.parse(req.query);

    const { requests, total } = await inventoryService.listReorderRequests(
      tenantId,
      { ...filters, allowedLocationIds: getAllowedLocationIds(req) },
    );

    res.json(
      paginationResponse(
        "requests",
        requests,
        total,
        filters.page,
        filters.limit,
      ),
    );
  },
);

export const createReorderRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createReorderRequestSchema.parse(req.body);

    const request = await inventoryService.createReorderRequest(
      tenantId,
      createdBy,
      input,
      getAllowedLocationIds(req),
    );

    res.status(201).json(request);
  },
);

export const receiveReorderRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = idParamsSchema.parse(req.params);
    const receivedBy = getAuthenticatedUserId(req);
    const input = receiveReorderRequestSchema.parse(req.body);

    const request = await inventoryService.receiveReorderRequest(
      tenantId,
      id,
      input,
      receivedBy,
      getAllowedLocationIds(req),
    );

    res.json(request);
  },
);

export const updateReorderRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = idParamsSchema.parse(req.params);
    const updatedBy = getAuthenticatedUserId(req);
    const input = updateReorderRequestSchema.parse(req.body);

    const request = await inventoryService.updateReorderRequest(
      tenantId,
      id,
      input,
      updatedBy,
      getAllowedLocationIds(req),
    );

    res.json(request);
  },
);
