import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requireWorkspaceSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { requireWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";

import {
  getWorkspaceNotificationSummary,
  listWorkspaceNotifications,
  markAllWorkspaceNotificationsRead,
  markWorkspaceNotificationRead,
} from "../controllers/workspace-notification.controller.js";

export const workspaceNotificationRouter = Router();

workspaceNotificationRouter.use(verifyJWT);
workspaceNotificationRouter.use(requireWorkspaceSession);
workspaceNotificationRouter.use(requireWorkspaceAccess);

workspaceNotificationRouter.get("/", listWorkspaceNotifications);
workspaceNotificationRouter.get("/summary", getWorkspaceNotificationSummary);
workspaceNotificationRouter.post(
  "/read-all",
  markAllWorkspaceNotificationsRead,
);
workspaceNotificationRouter.patch("/:id/read", markWorkspaceNotificationRead);

export default workspaceNotificationRouter;
