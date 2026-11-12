import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  readDoorAccessAutomation,
  patchDoorAccessAutomation,
} from "../controllers/door-access-automation.controller.js";

import {
  createCommunicationAutomation,
  deleteCommunicationAutomation,
  listCommunicationAutomations,
  updateCommunicationAutomation,
} from "../controllers/communication-automation.controller.js";

const router = express.Router();

router.use(verifyJWT);

router
  .route("/system/door-access")
  .get(
    requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW),
    requirePermission(WORKSPACE_PERMISSION.ACCESS_CODES_VIEW),
    readDoorAccessAutomation,
  )
  .patch(
    requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE),
    requirePermission(WORKSPACE_PERMISSION.ACCESS_CODES_MANAGE),
    patchDoorAccessAutomation,
  );

router
  .route("/")
  .get(
    requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW),
    listCommunicationAutomations,
  )
  .post(
    requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE),
    createCommunicationAutomation,
  );

router
  .route("/:id")
  .patch(
    requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE),
    updateCommunicationAutomation,
  )
  .delete(
    requirePermission(WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE),
    deleteCommunicationAutomation,
  );

export default router;
