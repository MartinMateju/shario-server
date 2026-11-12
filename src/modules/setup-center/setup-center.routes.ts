import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  abandonPractice,
  advancePractice,
  clearPracticeConfirmation,
  confirmPractice,
  getSetupAssistantResponse,
  getSetupCenter,
  publishCurrentStudio,
  startPractice,
  trackSetupLaunchEvent,
  unpublishCurrentStudio,
} from "./setup-center.controller.js";
import {
  setupAssistantLimiter,
  setupLaunchEventLimiter,
} from "./setup-center.limiter.js";

export const setupCenterRouter = Router();

setupCenterRouter.use(verifyJWT);
setupCenterRouter.use(requireWorkspaceAccess);

setupCenterRouter.get(
  "/",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  getSetupCenter,
);
setupCenterRouter.post(
  "/events",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  setupLaunchEventLimiter,
  trackSetupLaunchEvent,
);
setupCenterRouter.post(
  "/assistant",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  setupAssistantLimiter,
  getSetupAssistantResponse,
);
setupCenterRouter.post(
  "/practice",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  requirePermission(
    WORKSPACE_PERMISSION.PRODUCTS_VIEW,
    WORKSPACE_PERMISSION.BOOKINGS_CREATE,
  ),
  startPractice,
);
setupCenterRouter.post(
  "/practice/confirmation",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  requirePermission(
    WORKSPACE_PERMISSION.PRODUCTS_VIEW,
    WORKSPACE_PERMISSION.BOOKINGS_CREATE,
  ),
  confirmPractice,
);
setupCenterRouter.delete(
  "/practice/confirmation",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  requirePermission(
    WORKSPACE_PERMISSION.PRODUCTS_VIEW,
    WORKSPACE_PERMISSION.BOOKINGS_CREATE,
  ),
  clearPracticeConfirmation,
);
setupCenterRouter.post(
  "/practice/actions/:action",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  requirePermission(
    WORKSPACE_PERMISSION.PRODUCTS_VIEW,
    WORKSPACE_PERMISSION.BOOKINGS_CREATE,
  ),
  advancePractice,
);
setupCenterRouter.delete(
  "/practice",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  requirePermission(
    WORKSPACE_PERMISSION.PRODUCTS_VIEW,
    WORKSPACE_PERMISSION.BOOKINGS_CREATE,
  ),
  abandonPractice,
);
setupCenterRouter.post(
  "/publish",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_PUBLISH),
  publishCurrentStudio,
);
setupCenterRouter.post(
  "/unpublish",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_PUBLISH),
  unpublishCurrentStudio,
);

export default setupCenterRouter;
