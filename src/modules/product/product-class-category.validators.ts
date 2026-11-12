import { z } from "zod";

import { MAX_PRODUCT_CLASS_CATEGORY_LENGTH } from "./product.constants.js";
import { objectIdSchema } from "./product.validators.js";
import { hasVisibleProductClassCategoryName } from "./product-class-category.utils.js";

export const createProductClassCategorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PRODUCT_CLASS_CATEGORY_LENGTH)
      .refine(hasVisibleProductClassCategoryName, {
        message: "Category name must contain a visible character.",
      }),
  })
  .strict();

export const productClassCategoryParamsSchema = z.object({
  categoryId: objectIdSchema("class category id"),
});

export type CreateProductClassCategoryInput = z.infer<
  typeof createProductClassCategorySchema
>;
