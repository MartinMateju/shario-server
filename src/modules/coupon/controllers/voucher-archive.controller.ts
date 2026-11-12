import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { unauthorized } from "@/shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { objectIdSchema } from "../coupon.validators.js";
import { voucherArchiveService } from "../voucher-archive.service.js";

export const voucherArchiveSchema = z.object({
  operationId: z.uuid(),
  reason: z.string().trim().max(1000).optional(),
}).strict();

const changeVisibility = (action: "archive" | "restore") =>
  asyncHandler(async (req, res) => {
    const actorId = (req as Request & { userInfo?: { id?: string } }).userInfo?.id;
    if (!actorId) unauthorized("Authenticated user is required.");
    const input = voucherArchiveSchema.parse(req.body);
    const voucher = await voucherArchiveService[action]({
      ...input,
      tenantId: requireTenantId(req),
      couponId: objectIdSchema("voucher id").parse(req.params.couponId),
      actorId,
    });
    res.json({ voucher });
  });

export const archiveVoucher = changeVisibility("archive");
export const restoreVoucher = changeVisibility("restore");
