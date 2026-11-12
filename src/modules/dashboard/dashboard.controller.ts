import type { Request } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import { dashboardService } from "./dashboard.service.js";
import {
  dashboardOverviewQuerySchema,
  type ParsedDashboardOverviewQuery,
} from "./dashboard.validators.js";

const parseQuery = (value: unknown): ParsedDashboardOverviewQuery => {
  const parsed = dashboardOverviewQuerySchema.safeParse(value);

  if (!parsed.success) {
    badRequest({
      message: "Invalid dashboard filters.",
      code: "DASHBOARD_FILTERS_INVALID",
      details: parsed.error.flatten(),
    });
  }

  return parsed.data;
};

export const getDashboardOverview = asyncHandler(async (req: Request, res) => {
  const workspaceRequest = req as WorkspaceAccessRequest;
  const data = await dashboardService.overview({
    context: {
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      access: getResolvedWorkspaceAccess(workspaceRequest),
    },
    query: parseQuery(req.query),
  });

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).json({ data });
});

