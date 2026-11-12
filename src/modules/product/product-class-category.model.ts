import mongoose from "mongoose";

import { productClassCategorySchema } from "./product-class-category.schema.js";
import type {
  ProductClassCategoryAttributes,
  ProductClassCategoryModel as ProductClassCategoryModelType,
} from "./product-class-category.types.js";

export const ProductClassCategoryModel =
  (mongoose.models.ProductClassCategory as
    ProductClassCategoryModelType | undefined) ??
  mongoose.model<ProductClassCategoryAttributes, ProductClassCategoryModelType>(
    "ProductClassCategory",
    productClassCategorySchema,
  );

export default ProductClassCategoryModel;
