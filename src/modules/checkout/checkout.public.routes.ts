import { Router, type NextFunction, type Response } from "express";

import {
  getCoupons,
  sendCouponCheckout,
} from "@/modules/coupon/controllers/coupon.controller.js";
import {
  downloadVoucherPurchase,
  getVoucherPurchaseStatus,
  resendVoucherPurchase,
  voucherPurchaseResponseHeaders,
} from "@/modules/coupon/controllers/voucher-purchase.controller.js";
import {
  loadPublishedTenant,
  type PublishedTenantRequest,
} from "@/modules/setup-center/setup-publication.middleware.js";
import { getTenantSubscriptionAccess } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import { getTenantBySlug } from "@/modules/tenants/services/tenant.service.js";
import { TENANT_SLUG_REGEX } from "@/modules/tenants/tenant.validators.js";
import { isGuestCourseCheckoutEnabled } from "@/modules/tenants/public-site/tenant-course-visibility.js";

import { getGuestCheckoutOrderStatus } from "./controllers/checkout.controller.js";
import { getProtectedGuestCourseStatus, sendGuestCourseCheckout, quoteGuestCourseVoucher } from "./controllers/checkout.guest-course.controller.js";
import {
  publicCommerceMutationLimiter,
  publicTenantLookupLimiter,
} from "./checkout.public-limiter.js";

const requirePublicCommerceSubscription = async (
  req: PublishedTenantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.tenant) {
      res.status(404).json({ message: "Workspace not found." });
      return;
    }

    const { access } = await getTenantSubscriptionAccess(
      String(req.tenant._id),
    );

    if (!access.canUseFeatures) {
      res.status(403).json({
        message: "Online purchases are unavailable for this workspace.",
        code: "TENANT_SUBSCRIPTION_REQUIRED",
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};

const requireModules =
  (...moduleNames: string[]) =>
  (req: PublishedTenantRequest, res: Response, next: NextFunction): void => {
    const modules = req.tenant?.modules as Record<string, boolean> | undefined;
    const missing = moduleNames.find(
      (moduleName) => modules?.[moduleName] !== true,
    );

    if (missing) {
      res.status(403).json({
        message: "This purchase type is unavailable for this workspace.",
        code: "TENANT_MODULE_REQUIRED",
        requiredModule: missing,
      });
      return;
    }

    next();
  };

export const loadTenantForHistoricalOrderStatus = async (
  req: PublishedTenantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const tenantSlug = String(req.params.tenantSlug || "")
      .trim()
      .toLowerCase();
    if (
      tenantSlug.length < 2 ||
      tenantSlug.length > 80 ||
      !TENANT_SLUG_REGEX.test(tenantSlug)
    ) {
      res.status(404).json({ message: "Payment order not found." });
      return;
    }

    const tenant = await getTenantBySlug(tenantSlug);
    if (!tenant) {
      res.status(404).json({ message: "Payment order not found." });
      return;
    }

    req.tenant = tenant;
    req.tenantId = String(tenant._id);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Mount at `/public` from app/routes.ts. The tenant slug is explicit because
 * all browsers call the central API host, whose Host header cannot identify
 * the originating tenant subdomain.
 */
export const publicTenantCommerceRouter = Router({ mergeParams: true });

/*
 * Historical return links must remain verifiable even if a studio later
 * unpublishes, disables a module or temporarily loses subscription access.
 * The opaque order ID and tenant-scoped safe projection remain authoritative.
 */
publicTenantCommerceRouter.get(
  "/tenants/:tenantSlug/checkout/guest/orders/:orderId/status",
  publicTenantLookupLimiter,
  loadTenantForHistoricalOrderStatus,
  getGuestCheckoutOrderStatus,
);

publicTenantCommerceRouter.post(
  "/tenants/:tenantSlug/checkout/guest/orders/:orderId/status",
  voucherPurchaseResponseHeaders,
  publicTenantLookupLimiter,
  loadTenantForHistoricalOrderStatus,
  getProtectedGuestCourseStatus,
);

// A paid buyer must keep access after the studio disables new sales. The order
// ID alone is insufficient: every operation also requires its secret bearer.
publicTenantCommerceRouter.post(
  "/tenants/:tenantSlug/vouchers/orders/:orderId/status",
  voucherPurchaseResponseHeaders,
  publicTenantLookupLimiter,
  loadTenantForHistoricalOrderStatus,
  getVoucherPurchaseStatus,
);
publicTenantCommerceRouter.post(
  "/tenants/:tenantSlug/vouchers/orders/:orderId/download",
  voucherPurchaseResponseHeaders,
  publicTenantLookupLimiter,
  publicCommerceMutationLimiter,
  loadTenantForHistoricalOrderStatus,
  downloadVoucherPurchase,
);
publicTenantCommerceRouter.post(
  "/tenants/:tenantSlug/vouchers/orders/:orderId/resend",
  voucherPurchaseResponseHeaders,
  publicTenantLookupLimiter,
  publicCommerceMutationLimiter,
  loadTenantForHistoricalOrderStatus,
  resendVoucherPurchase,
);

publicTenantCommerceRouter.use(
  "/tenants/:tenantSlug",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  requirePublicCommerceSubscription,
);

/*
 * Guest checkout is deliberately course-only and explicitly opted in on the
 * published site. Other booking types still use authenticated checkout.
 */
publicTenantCommerceRouter.post(
  "/tenants/:tenantSlug/checkout/guest/voucher/quote",
  voucherPurchaseResponseHeaders,
  publicCommerceMutationLimiter,
  requireModules("payments", "courses"),
  (req: PublishedTenantRequest, res, next) => {
    if (!req.tenant || !isGuestCourseCheckoutEnabled(req.tenant)) {
      res.status(404).json({ code: "GUEST_COURSE_CHECKOUT_UNAVAILABLE", message: "Guest course checkout is unavailable for this studio." });
      return;
    }
    next();
  },
  quoteGuestCourseVoucher,
);
publicTenantCommerceRouter.post(
  "/tenants/:tenantSlug/checkout/guest",
  voucherPurchaseResponseHeaders,
  publicCommerceMutationLimiter,
  requireModules("payments", "courses"),
  (req: PublishedTenantRequest, res, next) => {
    if (!req.tenant || !isGuestCourseCheckoutEnabled(req.tenant)) {
      res.status(404).json({ code: "GUEST_COURSE_CHECKOUT_UNAVAILABLE", message: "Guest course checkout is unavailable for this studio." });
      return;
    }
    next();
  },
  sendGuestCourseCheckout,
);
publicTenantCommerceRouter.get(
  "/tenants/:tenantSlug/vouchers/products",
  requireModules("vouchers"),
  getCoupons,
);
publicTenantCommerceRouter.post(
  "/tenants/:tenantSlug/vouchers/checkout",
  publicCommerceMutationLimiter,
  requireModules("payments", "vouchers"),
  sendCouponCheckout,
);

export default publicTenantCommerceRouter;
