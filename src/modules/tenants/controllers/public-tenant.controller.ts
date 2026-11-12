import type { Response } from "express";

import type { PublishedTenantRequest } from "@/modules/setup-center/setup-publication.middleware.js";
import { buildPublicTenantConfig } from "@/modules/tenants/public-site/tenant-public-site.config.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { notFound } from "@/shared/http/httpErrors.js";

export const getPublicTenantConfig = asyncHandler(
  async (req: PublishedTenantRequest, res: Response): Promise<void> => {
    if (!req.tenant) {
      notFound({
        message: "Workspace not found.",
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      });
    }

    // Publication changes must take effect on the next public request.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.status(200).json({
      tenant: await buildPublicTenantConfig(req.tenant),
    });
  },
);
