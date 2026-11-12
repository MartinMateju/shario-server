import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requireAnyPermission,
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { tenantPaymentConnectLimiter } from "@/shared/middleware/tenantPaymentConnectLimiter.js";

import {
  getCurrentTenantPaymentConnect,
  openCurrentTenantPaymentDashboard,
  startCurrentTenantPaymentOnboarding,
} from "../controllers/tenant-payment-connect.controller.js";

export const tenantPaymentConnectRouter = Router();

tenantPaymentConnectRouter.use(verifyJWT);
tenantPaymentConnectRouter.use(requireWorkspaceAccess);

tenantPaymentConnectRouter.get(
  "/",
  requireAnyPermission(
    WORKSPACE_PERMISSION.PAYMENTS_VIEW,
    WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
  ),
  getCurrentTenantPaymentConnect,
);

tenantPaymentConnectRouter.post(
  "/onboarding",
  requirePermission(WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE),
  tenantPaymentConnectLimiter,
  startCurrentTenantPaymentOnboarding,
);

tenantPaymentConnectRouter.post(
  "/dashboard",
  requirePermission(WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE),
  tenantPaymentConnectLimiter,
  openCurrentTenantPaymentDashboard,
);

export default tenantPaymentConnectRouter;

