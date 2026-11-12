import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { createPublicGuestCourseCheckout, getProtectedGuestCourseOrderStatus, quotePublicGuestCourseVoucher } from "../services/checkout.guest-course.service.js";

export const quoteGuestCourseVoucher = asyncHandler(async (req, res) => {
  res.json(await quotePublicGuestCourseVoucher({ tenantId: requireTenantId(req), body: req.body }));
});

export const sendGuestCourseCheckout = asyncHandler(async (req, res) => {
  res.json(await createPublicGuestCourseCheckout({
    tenantId: requireTenantId(req), body: req.body,
    idempotencyKey: req.get("Idempotency-Key"), requestedOrigin: req.get("origin"),
  }));
});

export const getProtectedGuestCourseStatus = asyncHandler(async (req, res) => {
  res.json(await getProtectedGuestCourseOrderStatus({
    tenantId: requireTenantId(req), orderId: String(req.params.orderId || ""),
    accessToken: req.body?.accessToken,
  }));
});
