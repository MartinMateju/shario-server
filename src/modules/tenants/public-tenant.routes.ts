import { Router } from "express";

import { publicTenantLookupLimiter } from "@/modules/checkout/checkout.public-limiter.js";
import { loadFreshPublishedTenant } from "@/modules/setup-center/setup-publication.middleware.js";

import { getPublicTenantConfig } from "./controllers/public-tenant.controller.js";

export const publicTenantRouter = Router();

publicTenantRouter.get(
  "/tenants/:tenantSlug/config",
  (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    next();
  },
  publicTenantLookupLimiter,
  loadFreshPublishedTenant,
  getPublicTenantConfig,
);

export default publicTenantRouter;
