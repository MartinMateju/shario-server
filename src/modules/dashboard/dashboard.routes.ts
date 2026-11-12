import { Router } from "express";

import {
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import { getDashboardOverview } from "./dashboard.controller.js";

export const dashboardRouter = Router();

dashboardRouter.use(requireWorkspaceAccess);
dashboardRouter.get(
  "/overview",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  getDashboardOverview,
);

export default dashboardRouter;

