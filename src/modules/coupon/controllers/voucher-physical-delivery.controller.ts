import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { unauthorized } from "@/shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { objectIdSchema } from "../coupon.validators.js";
import { voucherPhysicalDeliveryService } from "../voucher-physical-delivery.service.js";
import { voucherManagementService } from "../voucher-management.service.js";

export const voucherDispatchSchema = z.object({ operationId: z.uuid() }).strict();

export const markVoucherOrderDispatched = asyncHandler(async (req, res) => {
  const actorId = (req as Request & { userInfo?: { id?: string } }).userInfo?.id;
  if (!actorId) unauthorized("Authenticated user is required.");
  const input = voucherDispatchSchema.parse(req.body);
  const tenantId = requireTenantId(req);
  const couponOrderId = objectIdSchema("voucher order id").parse(req.params.orderId);
  await voucherPhysicalDeliveryService.dispatch({ ...input, tenantId, couponOrderId, actorId });
  res.json(await voucherManagementService.orderDetail(tenantId, couponOrderId));
});
