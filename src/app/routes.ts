import { Router } from "express";

import accessCodeRoutes from "@/modules/access-codes/routes/access-code.routes.js";
import authRoutes from "@/modules/auth/routes/auth.routes.js";
import accountRoutes from "@/modules/account/account.routes.js";
import {
  requireCustomerSession,
  requireWorkspaceSession,
} from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import bookingRoutes from "@/modules/booking/booking.routes.js";
import { publicBookingRouter } from "@/modules/booking/booking.public.routes.js";
import { customOrderRouter } from "@/modules/custom-orders/custom-order.routes.js";
import { readCustomOrderAttachment } from "@/modules/custom-orders/custom-order.media.js";
import { customerBookingRouter } from "@/modules/booking/booking.customer.routes.js";
import {
  customerBookingIntentRouter,
  publicBookingIntentRouter,
} from "@/modules/booking-intent/booking-intent.routes.js";
import cartRoutes from "@/modules/cart/cart.routes.js";
import checkoutRoutes from "@/modules/checkout/checkout.routes.js";
import { publicTenantCommerceRouter } from "@/modules/checkout/checkout.public.routes.js";
import dashboardRoutes from "@/modules/dashboard/dashboard.routes.js";
import dataImportRoutes from "@/modules/data-import/data-import.routes.js";
import communicationAutomationRoutes from "@/modules/communication-automations/routes/communication-automation.routes.js";
import communicationEmailLogRoutes from "@/modules/communication-email-logs/routes/communication-email-log.routes.js";
import communicationsRoutes from "@/modules/communications/routes/communications.routes.js";
import { publicCommunicationRouter } from "@/modules/communications/routes/communications.public.routes.js";
import {
  customerKnowledgeRouter,
  publicKnowledgeRouter,
  workspaceKnowledgeRouter,
} from "@/modules/communications/routes/knowledge.routes.js";
import couponRoutes, {
  customerCouponRouter,
} from "@/modules/coupon/routes/coupon.routes.js";
import emailTemplateRoutes from "@/modules/email-template/email-template.routes.js";
import emailVerificationRoutes from "@/modules/verification/routes/user-verification.routes.js";
import eventRoutes from "@/modules/event/routes/event.routes.js";
import inventoryRoutes from "@/modules/inventory/routes/inventory.routes.js";
import invoiceRoutes from "@/modules/invoice/invoice.routes.js";
import { customerInvoiceRouter } from "@/modules/invoice/invoice.routes.js";
import locationRoutes from "@/modules/location/routes/location.routes.js";
import membershipRoutes, {
  customerMembershipRouter,
  publicMembershipRouter,
} from "@/modules/membership/routes/membership.routes.js";
import metadataRoutes from "@/modules/metadata/routes/metadata.routes.js";
import publicMediaRouter from "@/modules/media/public-media.routes.js";
import moneyCreditRoutes from "@/modules/money-credit/routes/money-credit.routes.js";
import notificationRoutes from "@/modules/notification/routes/notification.routes.js";
import orderRoutes from "@/modules/order/order.routes.js";
import { customerOrderRouter } from "@/modules/order/order.customer.routes.js";
import passwordResetRoutes from "@/modules/password_reset/routes/password-reset.routes.js";
import productRoutes from "@/modules/product/routes/product.routes.js";
import { publicProductRouter } from "@/modules/product/routes/product.public.routes.js";
import registeredSenderEmailRoutes from "@/modules/registered-sender-email/routes/registered-sender-email.routes.js";
import reportsRoutes from "@/modules/reports/reports.routes.js";
import rootRoutes from "@/app/root.routes.js";
import staffRoutes from "@/modules/staff/routes/staff.routes.js";
import staffPlanningRoutes from "@/modules/staff/routes/staff-planning.routes.js";
import supplyOrderRoutes from "@/modules/supplies/routes/supply-order.routes.js";
import userRoutes from "@/modules/user/user.routes.js";
import { tenantOnboardingRouter } from "@/modules/tenants/onboarding/tenant-onboarding.routes.js";
import { publicTenantRouter } from "@/modules/tenants/public-tenant.routes.js";
import { tenantSettingsRouter } from "@/modules/tenants/settings/tenant-settings.routes.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import {
  requireAnyTenantModule,
  requireTenantModule,
} from "@/modules/tenants/middleware/requireTenantModule.js";
import {
  requireTenantAiCapability,
  requireTenantOperationCapability,
} from "@/modules/tenants/middleware/requireTenantPlanCapability.js";
import { tenantAccessRouter } from "@/modules/tenant-access/index.js";
import { tenantSubscriptionRouter } from "@/modules/tenant-subscription/routes/tenant-subscription.routes.js";
import { publicSubscriptionCatalogRouter } from "@/modules/tenant-subscription/routes/tenant-subscription.public.routes.js";
import { tenantPaymentConnectRouter } from "@/modules/tenant-payments/index.js";
import { setupCenterRouter } from "@/modules/setup-center/setup-center.routes.js";
import { requireTenantSubscriptionAccess } from "@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js";
import {
  aiRouter,
  customerAiRouter,
  publicAiRouter,
} from "@/modules/ai/ai.routes.js";
import { customerWaitlistRouter } from "@/modules/waitlist/waitlist.customer.routes.js";
import { publicWaitlistRouter } from "@/modules/waitlist/waitlist.public.routes.js";
import { customerNotificationRouter } from "@/modules/customer-notifications/routes/customer-notification.routes.js";
import {
  registerWorkspaceNotificationPublisher,
  workspaceNotificationRouter,
} from "@/modules/workspace-notifications/index.js";

export const apiRouter: Router = Router();

registerWorkspaceNotificationPublisher();

apiRouter.use("/", rootRoutes);
apiRouter.use("/media/public", publicMediaRouter);

apiRouter.use("/auth", authRoutes);
apiRouter.use("/account", accountRoutes);
apiRouter.use(
  "/tenants/current/access",
  verifyJWT,
  requireWorkspaceSession,
  tenantAccessRouter,
);
apiRouter.use(
  "/tenants/current/onboarding",
  verifyJWT,
  requireWorkspaceSession,
  tenantOnboardingRouter,
);
apiRouter.use(
  "/tenants/current/subscription",
  verifyJWT,
  requireWorkspaceSession,
  tenantSubscriptionRouter,
);
apiRouter.use(
  "/tenants/current/setup-center",
  verifyJWT,
  requireWorkspaceSession,
  setupCenterRouter,
);
apiRouter.use("/tenants/current/notifications", workspaceNotificationRouter);
apiRouter.use("/notifications/mine", customerNotificationRouter);
// Customers retain access to their legal documents even if the workspace's
// feature subscription is temporarily restricted.
apiRouter.use(
  "/invoices/mine",
  verifyJWT,
  requireCustomerSession,
  customerInvoiceRouter,
);
apiRouter.use(
  "/bookings/mine",
  verifyJWT,
  requireCustomerSession,
  customerBookingRouter,
);
apiRouter.use(
  "/orders/mine",
  verifyJWT,
  requireCustomerSession,
  customerOrderRouter,
);
apiRouter.use(
  "/booking-intents",
  verifyJWT,
  requireCustomerSession,
  customerBookingIntentRouter,
);
apiRouter.use("/waitlist", customerWaitlistRouter);
apiRouter.use(
  "/ai/customer",
  verifyJWT,
  requireCustomerSession,
  customerAiRouter,
);
apiRouter.use("/knowledge", customerKnowledgeRouter);
apiRouter.use("/password-reset", passwordResetRoutes);
apiRouter.use("/email-verification", emailVerificationRoutes);
apiRouter.use("/public", publicAiRouter);
apiRouter.use("/public", publicSubscriptionCatalogRouter);
apiRouter.use("/public", publicTenantRouter);
apiRouter.use("/public", publicProductRouter);
apiRouter.use("/public", publicBookingRouter);
apiRouter.use("/public", publicBookingIntentRouter);
apiRouter.use("/public", publicTenantCommerceRouter);
apiRouter.use("/public", publicMembershipRouter);
apiRouter.use("/public", publicWaitlistRouter);
apiRouter.use("/public", publicKnowledgeRouter);
apiRouter.use("/communications", publicCommunicationRouter);
// Customer membership cancellation, invoices and billing recovery remain
// available even when the workspace's own SaaS subscription is restricted.
apiRouter.use("/memberships", customerMembershipRouter);
// Voucher redemption and owned voucher history remain available when the
// workspace disables new voucher sales.
apiRouter.use("/coupons", customerCouponRouter);
apiRouter.get(
  "/custom-orders/media/:id/:attachmentId",
  readCustomOrderAttachment,
);
apiRouter.use(verifyJWT, requireTenantSubscriptionAccess);

const bookingWorkflowModule = requireAnyTenantModule([
  TENANT_MODULE.BOOKINGS,
  TENANT_MODULE.COURSES,
]);
const paymentsModule = requireTenantModule(TENANT_MODULE.PAYMENTS);
const customersModule = requireTenantModule(TENANT_MODULE.CUSTOMERS);
const coursesModule = requireTenantModule(TENANT_MODULE.COURSES);
const membershipsModule = requireTenantModule(TENANT_MODULE.MEMBERSHIPS);
const creditsModule = requireTenantModule(TENANT_MODULE.CREDITS);
const vouchersModule = requireTenantModule(TENANT_MODULE.VOUCHERS);
const accessCodesModule = requireTenantModule(TENANT_MODULE.ACCESS_CODES);
const inventoryModule = requireTenantModule(TENANT_MODULE.INVENTORY);
const staffTasksModule = requireTenantModule(TENANT_MODULE.STAFF_TASKS);
const automationsModule = requireTenantModule(TENANT_MODULE.AUTOMATIONS);
const communicationsModule = requireTenantModule(TENANT_MODULE.COMMUNICATIONS);
const aiModule = requireTenantModule(TENANT_MODULE.AI);
const knowledgeHubCapability = requireTenantAiCapability("knowledgeHub");

apiRouter.use(
  "/tenants/current/settings",
  requireWorkspaceSession,
  tenantSettingsRouter,
);

apiRouter.use("/users", requireWorkspaceSession, customersModule, userRoutes);

apiRouter.use("/imports", requireWorkspaceSession, dataImportRoutes);

apiRouter.use("/locations", locationRoutes);
apiRouter.use(
  "/tenant-payments/connect",
  requireWorkspaceSession,
  paymentsModule,
  tenantPaymentConnectRouter,
);
apiRouter.use(
  "/bookings",
  requireWorkspaceSession,
  bookingWorkflowModule,
  bookingRoutes,
);
apiRouter.use(
  "/access-codes",
  requireWorkspaceSession,
  accessCodesModule,
  accessCodeRoutes,
);

apiRouter.use("/checkout", requireCustomerSession, checkoutRoutes);
apiRouter.use("/cart", cartRoutes);
apiRouter.use("/products", productRoutes);
apiRouter.use("/orders", requireWorkspaceSession, paymentsModule, orderRoutes);
// Custom production work does not charge customers and has no payments-module dependency.
apiRouter.use("/custom-orders", requireWorkspaceSession, customOrderRouter);
apiRouter.use(
  "/invoices",
  requireWorkspaceSession,
  paymentsModule,
  invoiceRoutes,
);
apiRouter.use("/coupons", vouchersModule, couponRoutes);
apiRouter.use("/credits", creditsModule, moneyCreditRoutes);
apiRouter.use(
  "/memberships",
  requireWorkspaceSession,
  membershipsModule,
  membershipRoutes,
);

apiRouter.use(
  "/inventory",
  requireWorkspaceSession,
  inventoryModule,
  inventoryRoutes,
);
apiRouter.use(
  "/supply-orders",
  requireWorkspaceSession,
  inventoryModule,
  supplyOrderRoutes,
);
apiRouter.use("/staff", requireWorkspaceSession, staffRoutes);
apiRouter.use(
  "/staff-planning",
  requireWorkspaceSession,
  staffTasksModule,
  staffPlanningRoutes,
);
apiRouter.use("/events", requireWorkspaceSession, coursesModule, eventRoutes);

apiRouter.use("/notifications", requireWorkspaceSession, notificationRoutes);
apiRouter.use(
  "/communication-automations",
  requireWorkspaceSession,
  automationsModule,
  communicationsModule,
  communicationAutomationRoutes,
);
apiRouter.use(
  "/communication-email-logs",
  requireWorkspaceSession,
  communicationsModule,
  communicationEmailLogRoutes,
);
apiRouter.use(
  "/knowledge",
  requireWorkspaceSession,
  knowledgeHubCapability,
  workspaceKnowledgeRouter,
);
apiRouter.use(
  "/communications",
  requireWorkspaceSession,
  communicationsModule,
  communicationsRoutes,
);
apiRouter.use(
  "/registered-sender-emails",
  requireWorkspaceSession,
  communicationsModule,
  registeredSenderEmailRoutes,
);
apiRouter.use(
  "/email-templates",
  requireWorkspaceSession,
  communicationsModule,
  emailTemplateRoutes,
);

apiRouter.use("/metadata", requireWorkspaceSession, metadataRoutes);
apiRouter.use("/dashboard", requireWorkspaceSession, dashboardRoutes);
apiRouter.use("/reports", requireWorkspaceSession, reportsRoutes);
apiRouter.use("/ai", requireWorkspaceSession, aiModule, aiRouter);
