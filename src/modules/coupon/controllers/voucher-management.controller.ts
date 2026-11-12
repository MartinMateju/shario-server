import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { unauthorized } from "@/shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { objectIdSchema } from "../coupon.validators.js";
import { voucherManagementService } from "../voucher-management.service.js";

export const voucherManagementDownloadSchema = z
  .object({ index: z.number().int().min(0).max(19) })
  .strict();
export const voucherManagementRefundSchema = z
  .object({ operationId: z.uuid(), reason: z.string().trim().min(1).max(1000) })
  .strict();
const emptyBody = z.object({}).strict();
const orderId = (req: Request) =>
  objectIdSchema("voucher order id").parse(req.params.orderId);

export const getManagedVoucher = asyncHandler(async (req, res) => {
  res.json(
    await voucherManagementService.detail(
      requireTenantId(req),
      objectIdSchema("voucher id").parse(req.params.couponId),
    ),
  );
});
export const getManagedVoucherOrder = asyncHandler(async (req, res) => {
  res.json(
    await voucherManagementService.orderDetail(
      requireTenantId(req),
      orderId(req),
    ),
  );
});
export const downloadManagedVoucherOrder = asyncHandler(async (req, res) => {
  const input = voucherManagementDownloadSchema.parse(req.body);
  const document = await voucherManagementService.download(
    requireTenantId(req),
    orderId(req),
    input.index,
  );
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${document.filename.replace(/[^A-Za-z0-9_.-]/g, "_")}"`,
  });
  res.send(document.content);
});
export const resendManagedVoucherOrder = asyncHandler(async (req, res) => {
  emptyBody.parse(req.body || {});
  res
    .status(202)
    .json(
      await voucherManagementService.resend(requireTenantId(req), orderId(req)),
    );
});
export const refundManagedVoucherOrder = asyncHandler(async (req, res) => {
  const actorId = (req as Request & { userInfo?: { id?: string } }).userInfo
    ?.id;
  if (!actorId) unauthorized("Authenticated user is required.");
  const input = voucherManagementRefundSchema.parse(req.body);
  res
    .status(202)
    .json(
      await voucherManagementService.refund({
        tenantId: requireTenantId(req),
        couponOrderId: orderId(req),
        actorId,
        ...input,
      }),
    );
});
