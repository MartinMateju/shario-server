// controllers/staff-member.controller.ts

import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";

import { staffMemberService } from "../services/staff-member.service.js";
import {
  createStaffMemberSchema,
  listStaffMembersSchema,
  staffMemberIdParamsSchema,
  updateStaffMemberSchema,
} from "../staff.validators.js";

const buildStaffContext = (req: Request) => ({
  tenantId: requireTenantId(req),
  id: getAuthenticatedUserId(req),
  allowedLocationIds: getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  ),
});

export const getStaffMembers = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await staffMemberService.list(
      buildStaffContext(req),
      listStaffMembersSchema.parse(req.query),
    );

    res.status(200).json(result);
  },
);

export const getStaffMemberById = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = staffMemberIdParamsSchema.parse(req.params);

    const result = await staffMemberService.getById(buildStaffContext(req), id);

    res.status(200).json(result);
  },
);

export const createStaffMember = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await staffMemberService.create(
      buildStaffContext(req),
      createStaffMemberSchema.parse(req.body),
    );

    res.status(201).json(result);
  },
);

export const updateStaffMember = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = staffMemberIdParamsSchema.parse(req.params);

    const result = await staffMemberService.update(
      buildStaffContext(req),
      id,
      updateStaffMemberSchema.parse(req.body),
    );

    res.status(200).json(result);
  },
);

export const deleteStaffMember = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = staffMemberIdParamsSchema.parse(req.params);

    const result = await staffMemberService.delete(buildStaffContext(req), id);

    res.status(200).json(result);
  },
);
