import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requireAnyPermission,
  requirePermission,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  getCommunicationEmailLogs,
  retryCommunicationEmail,
} from "../controllers/communication-email-log.controller.js";

const router = express.Router();

router.use(verifyJWT);

router.get(
  "/",
  requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW),
  getCommunicationEmailLogs,
);

router.post(
  "/:id/retry",
  requireAnyPermission(
    WORKSPACE_PERMISSION.COMMUNICATIONS_SEND,
    WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
  ),
  retryCommunicationEmail,
);

export default router;
