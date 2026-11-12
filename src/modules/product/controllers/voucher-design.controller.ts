import type { Request, Response } from "express";

import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import {
  getVoucherDesignDefaults,
  renderVoucherDesignPreview,
  uploadVoucherDesignAsset,
  voucherAssetUploadBodySchema,
} from "../services/voucher-design.service.js";

export const getVoucherEditorDefaults = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const design = await getVoucherDesignDefaults(requireTenantId(req));
    res.set("Cache-Control", "no-store").json({ design });
  },
);

export const uploadVoucherEditorAsset = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const { purpose } = voucherAssetUploadBodySchema.parse(req.body);
    if (!req.file)
      badRequest({
        code: "VOUCHER_ASSET_MISSING",
        message: "Choose an image to upload.",
      });
    const asset = await uploadVoucherDesignAsset({
      tenantId,
      purpose,
      file: req.file,
    });
    res.set("Cache-Control", "no-store").status(201).json(asset);
  },
);

export const previewVoucherEditor = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const svg = await renderVoucherDesignPreview({
      tenantId: requireTenantId(req),
      input: req.body,
      format: "svg",
    });
    res.set("Cache-Control", "no-store").json({ svg });
  },
);

export const downloadVoucherEditorSample = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const pdf = await renderVoucherDesignPreview({
      tenantId: requireTenantId(req),
      input: req.body,
      format: "pdf",
    });
    res
      .set({
        "Cache-Control": "no-store",
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="voucher-sample.pdf"',
        "X-Content-Type-Options": "nosniff",
      })
      .send(pdf);
  },
);
