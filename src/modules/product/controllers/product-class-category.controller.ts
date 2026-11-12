import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { productClassCategoryService } from "../services/product-class-category.service.js";
import {
  createProductClassCategorySchema,
  productClassCategoryParamsSchema,
} from "../product-class-category.validators.js";

export const listProductClassCategories = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    res.json(await productClassCategoryService.list(tenantId));
  },
);

export const createProductClassCategory = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createProductClassCategorySchema.parse(req.body);
    const category = await productClassCategoryService.create(
      tenantId,
      createdBy,
      input,
    );

    res.status(201).json({
      message: "Class category created.",
      category,
    });
  },
);

export const deleteProductClassCategory = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const { categoryId } = productClassCategoryParamsSchema.parse(req.params);
    const category = await productClassCategoryService.delete(
      tenantId,
      categoryId,
    );

    res.json({
      message: "Class category deleted.",
      category,
    });
  },
);
