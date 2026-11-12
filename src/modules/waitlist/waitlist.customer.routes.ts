import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requireVerifiedCustomer } from "@/modules/auth/middleware/requireVerifiedCustomer.js";
import { requireCustomerAccount } from "@/modules/auth/middleware/requireCustomerAccount.js";
import { requireTenantSubscriptionAccess } from "@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { sendWaitlistEntryCheckout } from "@/modules/checkout/controllers/checkout.controller.js";

import {
  getMyWaitlist,
  joinWaitlistAsCustomer,
  withdrawMyWaitlistEntry,
} from "./waitlist.customer.controller.js";

export const customerWaitlistRouter = Router();
customerWaitlistRouter.use(
  verifyJWT,
  requireCustomerSession,
);
customerWaitlistRouter.get("/mine", requireCustomerAccount, getMyWaitlist);
const coursesModule = requireTenantModule(TENANT_MODULE.COURSES);
const paymentsModule = requireTenantModule(TENANT_MODULE.PAYMENTS);
const newWaitlistCommerce = [
  requireTenantSubscriptionAccess,
  coursesModule,
  paymentsModule,
];

customerWaitlistRouter.post(
  "/entries",
  requireVerifiedCustomer,
  ...newWaitlistCommerce,
  joinWaitlistAsCustomer,
);
customerWaitlistRouter.delete("/entries/:entryId", requireCustomerAccount, withdrawMyWaitlistEntry);
customerWaitlistRouter.post(
  "/entries/:entryId/checkout",
  requireCustomerAccount,
  ...newWaitlistCommerce,
  sendWaitlistEntryCheckout,
);

export default customerWaitlistRouter;
