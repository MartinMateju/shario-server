import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { publicTenantLookupLimiter } from "@/modules/checkout/checkout.public-limiter.js";
import {
  requirePublicProductModule,
  requirePublicProductSubscription,
} from "@/modules/product/routes/product.public.routes.js";
import { loadPublishedTenant } from "@/modules/setup-center/setup-publication.middleware.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { requireTenantModule } from "@/shared/middleware/tenantFeatures.js";
import { loadMembershipTenant } from "../membership.middleware.js";
import { requireTenantSubscriptionAccess } from "@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js";
import {
  archiveMembershipPlan,
  createMembershipPlan,
  duplicateMembershipPlan,
  getMembershipPlan,
  getMembershipPlans,
  getCustomerMembershipCatalog,
  getPublicMembershipCatalog,
  publishMembershipPlan,
  updateMembershipPlan,
} from "../controllers/membership-plan.controller.js";
import {
  adjustUserMembership,
  assignMembershipToUser,
  cancelMyMembership,
  cancelUserMembership,
  createMembershipCheckout,
  createMyMembershipBillingPortal,
  scheduleMyMembershipPlanChange,
  cancelMyMembershipPlanChange,
  downloadMyMembershipInvoice,
  getMembershipCheckoutStatus,
  getMyMembership,
  getMyMembershipInvoice,
  getMyMembershipInvoices,
  getMyMembershipLedger,
  getUserMembership,
  getUserMembershipDetail,
  getUserMemberships,
  resumeMyMembership,
} from "../controllers/user-membership.controller.js";

export const membershipRouter = Router();
export const customerMembershipRouter = Router();
export const publicMembershipRouter = Router();

const membershipModule = requireTenantModule(TENANT_MODULE.MEMBERSHIPS);
const paymentModule = requireTenantModule(TENANT_MODULE.PAYMENTS);
const view = requirePermission(WORKSPACE_PERMISSION.MEMBERSHIPS_VIEW);
const manage = requirePermission(WORKSPACE_PERMISSION.MEMBERSHIPS_MANAGE);

membershipRouter.use(verifyJWT, loadMembershipTenant, membershipModule);
membershipRouter.route("/plans")
  .get(view, getMembershipPlans)
  .post(manage, createMembershipPlan);
membershipRouter.route("/plans/:id")
  .get(view, getMembershipPlan)
  .patch(manage, updateMembershipPlan);
membershipRouter.post("/plans/:id/publish", manage, publishMembershipPlan);
membershipRouter.post("/plans/:id/archive", manage, archiveMembershipPlan);
membershipRouter.post("/plans/:id/duplicate", manage, duplicateMembershipPlan);
membershipRouter.delete("/plans/:id", manage, archiveMembershipPlan); // legacy

membershipRouter.get("/user-memberships", view, getUserMemberships);
membershipRouter.get("/user-memberships/:id", view, getUserMembershipDetail);
membershipRouter.post("/user-memberships/:id/adjustments", manage, adjustUserMembership);
membershipRouter.post("/user-memberships/:id/cancel", manage, cancelUserMembership);
membershipRouter.post("/assign", manage, assignMembershipToUser);
membershipRouter.get("/user/:userId", view, getUserMembership); // legacy
membershipRouter.post("/user-memberships/:id/adjust", manage, adjustUserMembership); // legacy
membershipRouter.patch("/cancel/:id", manage, cancelUserMembership); // legacy

customerMembershipRouter.use(verifyJWT, loadMembershipTenant);
customerMembershipRouter.get(
  "/catalog",
  requireCustomerSession,
  requireTenantSubscriptionAccess,
  membershipModule,
  paymentModule,
  getCustomerMembershipCatalog,
);
customerMembershipRouter.use("/mine", requireCustomerSession);
customerMembershipRouter.use("/billing-portal", requireCustomerSession);
customerMembershipRouter.use("/checkout", requireCustomerSession);
customerMembershipRouter.get("/mine", getMyMembership);
customerMembershipRouter.get("/mine/ledger", getMyMembershipLedger);
customerMembershipRouter.get("/mine/invoices", getMyMembershipInvoices);
customerMembershipRouter.get("/mine/invoices/:invoiceId", getMyMembershipInvoice);
customerMembershipRouter.get("/mine/invoices/:invoiceId/document", downloadMyMembershipInvoice);
customerMembershipRouter.post("/mine/cancel", cancelMyMembership);
customerMembershipRouter.post("/mine/resume", resumeMyMembership);
customerMembershipRouter.post("/mine/plan-change", requireTenantSubscriptionAccess, membershipModule, paymentModule, scheduleMyMembershipPlanChange);
// Removing an existing financial instruction remains available if feature access changes.
customerMembershipRouter.delete("/mine/plan-change", cancelMyMembershipPlanChange);
customerMembershipRouter.post("/mine/billing-portal", paymentModule, createMyMembershipBillingPortal);
customerMembershipRouter.post("/billing-portal", paymentModule, createMyMembershipBillingPortal); // legacy
customerMembershipRouter.post(
  "/checkout",
  requireTenantSubscriptionAccess,
  membershipModule,
  paymentModule,
  createMembershipCheckout,
);
// A customer can return from Stripe after the tenant's feature/subscription
// state changes. This read-only, ownership-checked recovery route must remain
// available; only creation of a new Checkout Session is gated.
customerMembershipRouter.get("/checkout/:sessionId", getMembershipCheckoutStatus);

publicMembershipRouter.get(
  "/tenants/:tenantSlug/memberships",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.MEMBERSHIPS),
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  getPublicMembershipCatalog,
);
publicMembershipRouter.get(
  "/tenants/:tenantSlug/membership-plans",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.MEMBERSHIPS),
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  getPublicMembershipCatalog,
); // legacy

export default membershipRouter;
