import { Router } from "express";

import {
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { workspaceAiBriefingLimiter } from "@/modules/ai/ai.limiter.js";

import {
  getDashboardOverview,
  getDashboardManagement,
  createDashboardReport,
  downloadDashboardReportPdf,
} from "./dashboard.controller.js";

export const dashboardRouter = Router();

dashboardRouter.use(requireWorkspaceAccess);
dashboardRouter.get(
  "/overview",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  getDashboardOverview,
);

dashboardRouter.get(
  "/management",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  getDashboardManagement,
);
dashboardRouter.post(
  "/reports",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  requirePermission(WORKSPACE_PERMISSION.AI_USE),
  workspaceAiBriefingLimiter,
  createDashboardReport,
);
dashboardRouter.get(
  "/reports/:reportId/pdf",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  requirePermission(WORKSPACE_PERMISSION.REPORTS_EXPORT),
  downloadDashboardReportPdf,
);

export default dashboardRouter;
