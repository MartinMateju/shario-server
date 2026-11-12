import { Router } from "express";

import {
  publicCommerceMutationLimiter,
  publicTenantLookupLimiter,
} from "@/modules/checkout/checkout.public-limiter.js";
import { loadTenantForHistoricalOrderStatus } from "@/modules/checkout/checkout.public.routes.js";
import {
  requirePublicProductSubscription,
  requirePublicProductModule,
} from "@/modules/product/routes/product.public.routes.js";
import { loadPublishedTenant } from "@/modules/setup-center/setup-publication.middleware.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

import {
  checkoutGuestWaitlistOffer,
  inspectGuestWaitlistOffer,
  manageGuestWaitlist,
  requestGuestWaitlist,
  verifyGuestWaitlistToken,
  withdrawGuestWaitlist,
} from "./waitlist.public.controller.js";

export const publicWaitlistRouter = Router({ mergeParams: true });
publicWaitlistRouter.post(
  "/tenants/:tenantSlug/waitlist/entries",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  publicCommerceMutationLimiter,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  requirePublicProductModule(TENANT_MODULE.COURSES),
  requestGuestWaitlist,
);
publicWaitlistRouter.post(
  "/tenants/:tenantSlug/waitlist/verify",
  publicTenantLookupLimiter,
  loadTenantForHistoricalOrderStatus,
  publicCommerceMutationLimiter,
  verifyGuestWaitlistToken,
);
publicWaitlistRouter.post(
  "/tenants/:tenantSlug/waitlist/manage",
  publicTenantLookupLimiter,
  loadTenantForHistoricalOrderStatus,
  publicCommerceMutationLimiter,
  manageGuestWaitlist,
);
publicWaitlistRouter.post(
  "/tenants/:tenantSlug/waitlist/withdraw",
  publicTenantLookupLimiter,
  loadTenantForHistoricalOrderStatus,
  publicCommerceMutationLimiter,
  withdrawGuestWaitlist,
);
publicWaitlistRouter.post(
  "/tenants/:tenantSlug/waitlist/offers/inspect",
  publicTenantLookupLimiter,
  loadTenantForHistoricalOrderStatus,
  publicCommerceMutationLimiter,
  inspectGuestWaitlistOffer,
);
publicWaitlistRouter.post(
  "/tenants/:tenantSlug/waitlist/offers/checkout",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  publicCommerceMutationLimiter,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  requirePublicProductModule(TENANT_MODULE.COURSES),
  checkoutGuestWaitlistOffer,
);

export default publicWaitlistRouter;
