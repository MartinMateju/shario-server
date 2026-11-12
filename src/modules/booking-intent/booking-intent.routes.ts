import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requireCustomerAccount } from "@/modules/auth/middleware/requireCustomerAccount.js";
import {
  publicTenantLookupLimiter,
} from "@/modules/checkout/checkout.public-limiter.js";
import {
  requirePublicProductSubscription,
} from "@/modules/product/routes/product.public.routes.js";
import {
  loadPublishedTenant,
} from "@/modules/setup-center/setup-publication.middleware.js";

import {
  checkoutBookingIntentController,
  createBookingIntent,
  getBookingIntent,
  quoteBookingIntentVoucherController,
} from "./booking-intent.controller.js";

export const publicBookingIntentRouter = Router();
export const customerBookingIntentRouter = Router();

publicBookingIntentRouter.post(
  "/tenants/:tenantSlug/booking-intents",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  createBookingIntent,
);

customerBookingIntentRouter.use(
  verifyJWT,
  requireCustomerSession,
  requireCustomerAccount,
);
customerBookingIntentRouter.get("/:token", getBookingIntent);
customerBookingIntentRouter.post("/:token/voucher/quote", publicTenantLookupLimiter, quoteBookingIntentVoucherController);
customerBookingIntentRouter.post(
  "/:token/checkout",
  checkoutBookingIntentController,
);

export default customerBookingIntentRouter;
