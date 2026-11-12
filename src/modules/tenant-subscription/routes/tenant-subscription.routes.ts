import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { billingPortalLimiter } from "@/shared/middleware/billingPortalLimiter.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  cancelCurrentTenantSubscription,
  changeCurrentTenantPlan,
  getCurrentTenantSubscription,
  listCurrentTenantInvoices,
  openCurrentTenantBillingPortal,
  previewCurrentTenantPlanChange,
  resumeCurrentTenantSubscription,
  startCurrentTenantCheckout,
} from "../controllers/tenant-subscription.controller.js";

export const tenantSubscriptionRouter = Router();

tenantSubscriptionRouter.use(verifyJWT);
tenantSubscriptionRouter.get(
  "/",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_VIEW),
  getCurrentTenantSubscription,
);
tenantSubscriptionRouter.get(
  "/invoices",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_VIEW),
  listCurrentTenantInvoices,
);
tenantSubscriptionRouter.post(
  "/checkout",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE),
  startCurrentTenantCheckout,
);
tenantSubscriptionRouter.post(
  "/change-preview",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE),
  previewCurrentTenantPlanChange,
);
tenantSubscriptionRouter.post(
  "/change-plan",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE),
  changeCurrentTenantPlan,
);
tenantSubscriptionRouter.post(
  "/cancel",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE),
  cancelCurrentTenantSubscription,
);
tenantSubscriptionRouter.post(
  "/resume",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE),
  resumeCurrentTenantSubscription,
);
tenantSubscriptionRouter.post(
  "/portal",
  requirePermission(WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE),
  billingPortalLimiter,
  openCurrentTenantBillingPortal,
);

export default tenantSubscriptionRouter;
