import { Router } from "express";

import {
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  exportReportCsv,
  getReportOverview,
} from "./reports.controller.js";

export const reportsRouter = Router();

reportsRouter.use(requireWorkspaceAccess);
reportsRouter.get(
  "/overview",
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  getReportOverview,
);
reportsRouter.get(
  "/export.csv",
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  requirePermission(WORKSPACE_PERMISSION.REPORTS_EXPORT),
  exportReportCsv,
);

export default reportsRouter;

