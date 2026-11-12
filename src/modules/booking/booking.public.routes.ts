import { Router } from "express";

import { publicTenantLookupLimiter } from "@/modules/checkout/checkout.public-limiter.js";
import { loadPublishedTenant } from "@/modules/setup-center/setup-publication.middleware.js";
import { requirePublicProductSubscription } from "@/modules/product/routes/product.public.routes.js";

import {
  getPublicBookingOccupancy,
  getPublicBookingLocations,
  getPublicBookingSlots,
} from "./booking.public.controller.js";

export const publicBookingRouter = Router();

publicBookingRouter.get(
  "/tenants/:tenantSlug/booking/locations",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  getPublicBookingLocations,
);

publicBookingRouter.get(
  "/tenants/:tenantSlug/booking/availability",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  getPublicBookingSlots,
);

publicBookingRouter.get(
  "/tenants/:tenantSlug/booking/occupancy",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  getPublicBookingOccupancy,
);

export default publicBookingRouter;
