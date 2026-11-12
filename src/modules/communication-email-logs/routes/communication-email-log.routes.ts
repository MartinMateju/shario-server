import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { getCommunicationEmailLogs } from "../controllers/communication-email-log.controller.js";

const router = express.Router();

router.use(verifyJWT);

router.get(
  "/",
  requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW),
  getCommunicationEmailLogs,
);

export default router;
