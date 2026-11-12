import express from "express";

import {
  requireCustomerSession,
  requireWorkspaceSession,
} from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import {
  applyCouponPromoCode,
  createManualPromoCode,
  getCouponOrdersWithFilters,
  getCoupons,
  getCouponsWithFilters,
  getUserRedeemedCoupons,
  sendCouponCheckout,
  updateCouponOrderStatus,
  revokeVoucher,
} from "../controllers/coupon.controller.js";

import { getManagedVoucher, getManagedVoucherOrder, downloadManagedVoucherOrder, resendManagedVoucherOrder, refundManagedVoucherOrder } from "../controllers/voucher-management.controller.js";
import { voucherPurchaseResponseHeaders } from "../controllers/voucher-purchase.controller.js";
import { archiveVoucher, restoreVoucher } from "../controllers/voucher-archive.controller.js";
import { markVoucherOrderDispatched } from "../controllers/voucher-physical-delivery.controller.js";

const router = express.Router();
export const customerCouponRouter = express.Router();
const paymentsModule = requireTenantModule(TENANT_MODULE.PAYMENTS);

router.post(
  "/checkout",
  verifyJWT,
  requireCustomerSession,
  paymentsModule,
  sendCouponCheckout,
);
router.get(
  "/products",
  verifyJWT,
  requireCustomerSession,
  getCoupons,
);

customerCouponRouter.post(
  "/redeem",
  verifyJWT,
  requireCustomerSession,
  applyCouponPromoCode,
);
customerCouponRouter.get(
  "/redeem",
  verifyJWT,
  requireCustomerSession,
  getUserRedeemedCoupons,
);

router.use(verifyJWT, requireWorkspaceSession);

const viewVouchers = requirePermission(WORKSPACE_PERMISSION.VOUCHERS_VIEW);
const manageVouchers = requirePermission(WORKSPACE_PERMISSION.VOUCHERS_MANAGE);

router.get("/orders/:orderId", viewVouchers, voucherPurchaseResponseHeaders, getManagedVoucherOrder);
router.post("/orders/:orderId/download", viewVouchers, voucherPurchaseResponseHeaders, downloadManagedVoucherOrder);
router.post("/orders/:orderId/resend", manageVouchers, voucherPurchaseResponseHeaders, resendManagedVoucherOrder);
router.post("/orders/:orderId/refund", manageVouchers, voucherPurchaseResponseHeaders, refundManagedVoucherOrder);
router.post("/orders/:orderId/dispatch", manageVouchers, voucherPurchaseResponseHeaders, markVoucherOrderDispatched);
router.get("/promo-codes/:couponId", viewVouchers, voucherPurchaseResponseHeaders, getManagedVoucher);

router.post("/orders/filter", viewVouchers, getCouponOrdersWithFilters);
router.patch("/orders/status", manageVouchers, updateCouponOrderStatus);

router.post("/promo-codes/filter", viewVouchers, getCouponsWithFilters);
router.post("/promo-codes", manageVouchers, createManualPromoCode);
router.patch("/promo-codes/:couponId/revoke", manageVouchers, revokeVoucher);
router.patch("/promo-codes/:couponId/archive", manageVouchers, voucherPurchaseResponseHeaders, archiveVoucher);
router.patch("/promo-codes/:couponId/restore", manageVouchers, voucherPurchaseResponseHeaders, restoreVoucher);

export default router;
