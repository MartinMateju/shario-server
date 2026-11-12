import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";

import { communicationAutomationService } from "@/modules/communication-automations/services/communication-automation.service.js";
import {
  communicationAutomationIdParamsSchema,
  createCommunicationAutomationSchema,
  listCommunicationAutomationsSchema,
  updateCommunicationAutomationSchema,
} from "../communication-automation.validators.js";

type RequestWithUser = Request & {
  userInfo?: {
    id?: string;
    userId?: string;
    tenantId?: string;
  };
  user?: {
    _id?: string;
    id?: string;
  };
};

const getCurrentUserId = (req: RequestWithUser): string => {
  const userId =
    req.userInfo?.id ||
    req.userInfo?.userId ||
    req.user?._id ||
    req.user?.id;

  if (!userId) {
    throw Object.assign(new Error("Authenticated user context is missing."), {
      statusCode: 401,
    });
  }

  return String(userId);
};

const getAllowedLocationIds = (req: RequestWithUser) =>
  getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  );

export const listCommunicationAutomations = asyncHandler(
  async (req: RequestWithUser, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listCommunicationAutomationsSchema.parse(req.query);

    const result = await communicationAutomationService.list({
      ...filters,
      tenantId,
      allowedLocationIds: getAllowedLocationIds(req),
    });

    res.status(200).json(result);
  },
);

export const createCommunicationAutomation = asyncHandler(
  async (req: RequestWithUser, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getCurrentUserId(req);
    const input = createCommunicationAutomationSchema.parse(req.body);

    const automation = await communicationAutomationService.create(
      tenantId,
      createdBy,
      input,
      getAllowedLocationIds(req),
    );

    res.status(201).json(automation);
  },
);

export const updateCommunicationAutomation = asyncHandler(
  async (req: RequestWithUser, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = communicationAutomationIdParamsSchema.parse(req.params);

    const input = updateCommunicationAutomationSchema.parse({
      ...req.body,
      id,
    });

    const automation = await communicationAutomationService.update(
      tenantId,
      input,
      getAllowedLocationIds(req),
    );

    res.status(200).json(automation);
  },
);

export const deleteCommunicationAutomation = asyncHandler(
  async (req: RequestWithUser, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = communicationAutomationIdParamsSchema.parse(req.params);

    const result = await communicationAutomationService.delete(
      tenantId,
      id,
      getAllowedLocationIds(req),
    );

    res.status(200).json(result);
  },
);
