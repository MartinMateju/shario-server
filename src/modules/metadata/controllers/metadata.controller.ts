import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { metadataService } from "../services/metadata.service.js";
import {
  createMetadataManySchema,
  createMetadataSchema,
  listMetadataSchema,
} from "../metadata.validators.js";

export const listMetadata = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listMetadataSchema.parse(req.query);

    const result = await metadataService.list(tenantId, filters);

    res.json(result);
  },
);

export const createMetadata = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = createMetadataSchema.parse(req.body);

    const metadata = await metadataService.create(tenantId, input);

    res.status(201).json(metadata);
  },
);

export const createMetadataMany = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = createMetadataManySchema.parse(req.body);

    const ids = await metadataService.createMany(tenantId, input.items);

    res.status(201).json({ ids });
  },
);
