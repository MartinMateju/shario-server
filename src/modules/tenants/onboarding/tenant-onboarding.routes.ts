import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  completeCurrentTenantOnboarding,
  getCurrentTenantOnboarding,
  saveCurrentTenantOnboarding,
} from "./tenant-onboarding.controller.js";

export const tenantOnboardingRouter = Router();

/*
|--------------------------------------------------------------------------
| Authentication
|--------------------------------------------------------------------------
|
| All onboarding endpoints require a valid access token. The tenant ID
| is read from the authenticated user's JWT.
|
*/

tenantOnboardingRouter.use(verifyJWT);

/*
|--------------------------------------------------------------------------
| Current tenant onboarding
|--------------------------------------------------------------------------
*/

tenantOnboardingRouter.get(
  "/",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
  getCurrentTenantOnboarding,
);

tenantOnboardingRouter.patch(
  "/",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  saveCurrentTenantOnboarding,
);

tenantOnboardingRouter.post(
  "/complete",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  completeCurrentTenantOnboarding,
);

export default tenantOnboardingRouter;
