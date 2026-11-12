// controllers/staff-task.controller.ts

import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";

import { staffTaskService } from "../services/staff-task.service.js";
import {
  createStaffTaskSchema,
  listStaffTasksSchema,
  staffTaskIdParamsSchema,
  updateStaffTaskSchema,
} from "../staff.validators.js";

const buildStaffContext = (req: Request) => ({
  tenantId: requireTenantId(req),
  id: getAuthenticatedUserId(req),
  allowedLocationIds: getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  ),
  defaultLocationId:
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest).preferences
      .defaultLocation,
});

export const getStaffTasks = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await staffTaskService.list(
      buildStaffContext(req),
      listStaffTasksSchema.parse(req.query),
    );

    res.status(200).json(result);
  },
);

export const createStaffTask = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await staffTaskService.create(
      buildStaffContext(req),
      createStaffTaskSchema.parse(req.body),
    );

    res.status(201).json(result);
  },
);

export const updateStaffTask = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = staffTaskIdParamsSchema.parse(req.params);

    const result = await staffTaskService.update(
      buildStaffContext(req),
      id,
      updateStaffTaskSchema.parse(req.body),
    );

    res.status(200).json(result);
  },
);

export const deleteStaffTask = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = staffTaskIdParamsSchema.parse(req.params);

    const result = await staffTaskService.delete(buildStaffContext(req), id);

    res.status(200).json(result);
  },
);
