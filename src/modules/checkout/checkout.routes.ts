import rateLimit from "express-rate-limit";
import express, { type NextFunction, type Response } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requireCustomerAccount } from "@/modules/auth/middleware/requireCustomerAccount.js";
import { requireVerifiedCustomer } from "@/modules/auth/middleware/requireVerifiedCustomer.js";
import type { RequestWithTenant } from "@/modules/tenants/tenant.types.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";

import {
  checkoutWithCredits,
  confirmIncreaseParticipants,
  getCheckoutOrderStatus,
  requestRefundParticipants,
  sendCheckout,
  quoteVoucherCheckout,
  cancelVoucherPayment,
  quoteCheckout,
  checkoutWithMembership,
} from "./controllers/checkout.controller.js";

const router = express.Router();

router.use(verifyJWT, requireCustomerSession, requireCustomerAccount);

const voucherCheckoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.body?.voucherCode,
  message: {
    code: "VOUCHER_RATE_LIMITED",
    message: "Too many voucher attempts. Try again shortly.",
  },
});

const paymentsModule = requireTenantModule("payments");
const creditsModule = requireTenantModule("credits");
const membershipsModule = requireTenantModule("memberships");

export const requireCheckoutWorkflowModule = (
  req: RequestWithTenant,
  res: Response,
  next: NextFunction,
): void => {
  const rawCart =
    req.body && typeof req.body === "object"
      ? (req.body as { cart?: unknown }).cart
      : undefined;
  const cartItems = Array.isArray(rawCart)
    ? rawCart
    : rawCart && typeof rawCart === "object"
      ? Object.values(rawCart)
      : [];
  const productTypes = cartItems
    .map((item) =>
      String((item as { product?: { type?: unknown } })?.product?.type || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

  if (productTypes.length === 0) {
    next();
    return;
  }

  const modules = req.tenant?.modules;
  const hasCourse = productTypes.some((type) => type.includes("course"));
  const hasService = productTypes.some((type) => type === "service");
  const hasBookingProduct = productTypes.some(
    (type) => type !== "service" && !type.includes("course"),
  );

  if (hasCourse && !modules?.courses) {
    res.status(403).json({
      message: 'The "courses" module is not enabled for this tenant.',
      code: "TENANT_MODULE_REQUIRED",
      requiredModule: "courses",
    });
    return;
  }

  if (hasService && !modules?.bookings && !modules?.courses) {
    res.status(403).json({
      message:
        'Standalone services require either the "bookings" or "courses" module.',
      code: "TENANT_MODULE_REQUIRED",
      requiredModules: ["bookings", "courses"],
    });
    return;
  }

  if (hasBookingProduct && !modules?.bookings) {
    res.status(403).json({
      message: 'The "bookings" module is not enabled for this tenant.',
      code: "TENANT_MODULE_REQUIRED",
      requiredModule: "bookings",
    });
    return;
  }

  next();
};

router.post("/quote", paymentsModule, requireCheckoutWorkflowModule, quoteCheckout);
router.post("/membership", paymentsModule, membershipsModule, requireCheckoutWorkflowModule, checkoutWithMembership);
router.post(
  "/voucher/quote",
  voucherCheckoutLimiter,
  paymentsModule,
  requireCheckoutWorkflowModule,
  quoteVoucherCheckout,
);
router.post(
  "/",
  voucherCheckoutLimiter,
  paymentsModule,
  requireCheckoutWorkflowModule,
  sendCheckout,
);
router.post(
  "/credits",
  paymentsModule,
  creditsModule,
  requireCheckoutWorkflowModule,
  checkoutWithCredits,
);
router.get("/orders/:orderId/status", getCheckoutOrderStatus);
router.post("/orders/:orderId/voucher/cancel", cancelVoucherPayment);
router.post("/participants/increase-success", confirmIncreaseParticipants);
router.post("/participants/refund-request", requireVerifiedCustomer, requestRefundParticipants);

export default router;
