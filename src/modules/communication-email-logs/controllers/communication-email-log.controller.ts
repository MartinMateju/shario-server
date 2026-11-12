import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { communicationEmailLogService } from "../services/communication-email-log.service.js";
import { listCommunicationEmailLogsSchema } from "../communication-email-log.validators.js";

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
