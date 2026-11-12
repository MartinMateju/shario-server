import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requirePermission,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  createEmailNotification,
  getEmailNotificationById,
  getEmailNotifications,
  getNotificationLogs,
} from "../controllers/notification.controller.js";

const router = express.Router();

router.use(verifyJWT);

const viewCommunications = requirePermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
);
const manageCommunications = requirePermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);

router.get("/logs", viewCommunications, getNotificationLogs);

router
  .route("/email-notifications")
  .get(viewCommunications, getEmailNotifications)
  .post(manageCommunications, createEmailNotification);

router.get(
  "/email-notifications/:id",
  viewCommunications,
  getEmailNotificationById,
);

export default router;
