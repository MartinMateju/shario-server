import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { communicationEmailLogService } from "../services/communication-email-log.service.js";
import {
  communicationEmailLogIdParamsSchema,
  listCommunicationEmailLogsSchema,
  retryCommunicationEmailLogSchema,
} from "../communication-email-log.validators.js";
import { retryCommunicationEmailLog } from "../services/communication-email-log-retry.service.js";

export const getCommunicationEmailLogs = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = listCommunicationEmailLogsSchema.parse(req.query);

    const result = await communicationEmailLogService.list(
      tenantId,
      input,
      getAllowedWorkspaceLocationIds(
        getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
      ),
    );

    res.status(200).json(result);
  },
);

export const retryCommunicationEmail = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = communicationEmailLogIdParamsSchema.parse(req.params);
    const input = retryCommunicationEmailLogSchema.parse(req.body);
    const result = await retryCommunicationEmailLog({
      tenantId: requireTenantId(req),
      logId: id,
      actorId: getAuthenticatedUserId(req),
      expectedManualRetryCount: input.expectedManualRetryCount,
      allowedLocationIds: getAllowedWorkspaceLocationIds(
        getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
      ),
      ipAddress: req.ip,
      userAgent: req.get("user-agent") || "",
    });
    res.status(202).json(result);
  },
);
