import type { Request, Response } from "express";
import { z } from "zod";

import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";
import { voucherPurchaseService } from "../voucher-purchase.service.js";
import { VOUCHER_ACCESS_TOKEN_PATTERN } from "../voucher-order-access.js";

const proofSchema = z
  .object({ accessToken: z.string().regex(VOUCHER_ACCESS_TOKEN_PATTERN) })
  .strict();
const downloadSchema = proofSchema
  .extend({ index: z.number().int().min(0).max(49) })
  .strict();

const purchaseProof = (req: Request, download = false) => {
  const orderId = String(req.params.orderId || "");
  const token = req.body?.accessToken;
  if (
    !/^[a-f0-9]{24}$/i.test(orderId) ||
    typeof token !== "string" ||
    !VOUCHER_ACCESS_TOKEN_PATTERN.test(token)
  ) {
    notFound({
      code: "VOUCHER_PURCHASE_NOT_FOUND",
      message: "Voucher purchase access was not found or has expired.",
    });
  }
  const parsed = (download ? downloadSchema : proofSchema).safeParse(req.body);
  if (!parsed.success)
    badRequest({
      code: "VOUCHER_PURCHASE_INPUT_INVALID",
      message: "Invalid voucher purchase request.",
    });
  return {
    tenantId: requireTenantId(req),
    couponOrderId: orderId,
    ...parsed.data,
  };
};

export const voucherPurchaseResponseHeaders = (
  _req: Request,
  res: Response,
  next: () => void,
) => {
  res.set({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  next();
};

export const getVoucherPurchaseStatus = asyncHandler(async (req, res) => {
  res.json(await voucherPurchaseService.status(purchaseProof(req)));
});

export const downloadVoucherPurchase = asyncHandler(async (req, res) => {
  const input = purchaseProof(req, true);
  const document = await voucherPurchaseService.download({
    ...input,
    index: (input as typeof input & { index: number }).index,
  });
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${document.filename.replace(/[^A-Za-z0-9_.-]/g, "_")}"`,
  });
  res.send(document.content);
});

export const resendVoucherPurchase = asyncHandler(async (req, res) => {
  res.status(202).json(await voucherPurchaseService.resend(purchaseProof(req)));
});
