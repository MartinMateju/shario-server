import { listCustomerBookingLocations } from "@/modules/booking/booking.public.service.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { Router, type NextFunction, type Response } from "express";

import { publicTenantLookupLimiter } from "@/modules/checkout/checkout.public-limiter.js";
import {
  loadPublishedTenant,
  type PublishedTenantRequest,
} from "@/modules/setup-center/setup-publication.middleware.js";
import { getTenantSubscriptionAccess } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { isCourseBrowsingVisible } from "@/modules/tenants/public-site/tenant-course-visibility.js";

import {
  getPublicCourseSessions,
  getPublicCourseProducts,
  getPublicProduct,
  getPublicProducts,
} from "../controllers/product.controller.js";

export const requirePublicProductSubscription = async (
  req: PublishedTenantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.tenant) {
      res.status(404).json({
        message: "Workspace not found.",
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      });
      return;
    }

    const { access } = await getTenantSubscriptionAccess(
      String(req.tenant._id),
    );

    if (!access.canUseFeatures) {
      res.status(403).json({
        message: "The product catalog is unavailable for this workspace.",
        code: "TENANT_SUBSCRIPTION_REQUIRED",
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const requirePublicProductModule =
  (moduleName: string) =>
  (req: PublishedTenantRequest, res: Response, next: NextFunction): void => {
    const modules = req.tenant?.modules as Record<string, boolean> | undefined;

    if (modules?.[moduleName] !== true) {
      res.status(403).json({
        message: "The product catalog is unavailable for this workspace.",
        code: "TENANT_MODULE_REQUIRED",
        requiredModule: moduleName,
      });
      return;
    }

    next();
  };

export const requirePublicCourseVisibility = (
  req: PublishedTenantRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.tenant || !isCourseBrowsingVisible(req.tenant)) {
    res.set("Cache-Control", "no-store, max-age=0");
    res.status(404).json({
      message: "Courses are unavailable for this workspace.",
      code: "PUBLIC_COURSES_NOT_AVAILABLE",
    });
    return;
  }
  next();
};

/**
 * Mount at `/public`. Tenant identity comes exclusively from the validated,
 * published slug and is attached by `loadPublishedTenant`.
 */
export const publicProductRouter = Router({
  mergeParams: true,
});

publicProductRouter.get(
  "/tenants/:tenantSlug/products",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  getPublicProducts,
);

publicProductRouter.get(
  "/tenants/:tenantSlug/products/courses",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  requirePublicProductModule(TENANT_MODULE.COURSES),
  requirePublicCourseVisibility,
  getPublicCourseProducts,
);

publicProductRouter.get(
  "/tenants/:tenantSlug/products/courses/locations",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  requirePublicProductModule(TENANT_MODULE.COURSES),
  requirePublicCourseVisibility,
  asyncHandler(async (req: PublishedTenantRequest, res: Response) => {
    res.set("Cache-Control", "no-store, max-age=0");
    res.json(await listCustomerBookingLocations(req.tenant!));
  }),
);

publicProductRouter.get(
  "/tenants/:tenantSlug/products/:productId/sessions",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  requirePublicProductModule(TENANT_MODULE.COURSES),
  requirePublicCourseVisibility,
  getPublicCourseSessions,
);

publicProductRouter.get(
  "/tenants/:tenantSlug/products/:productId",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicProductSubscription,
  requirePublicProductModule(TENANT_MODULE.PAYMENTS),
  getPublicProduct,
);

export default publicProductRouter;
