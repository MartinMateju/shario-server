import mongoose from "mongoose";

import { productSchema } from "./product.schema.js";
import type { ProductAttributes, ProductModel } from "./product.types.js";

export const Product =
  (mongoose.models.Product as ProductModel | undefined) ||
  mongoose.model<ProductAttributes, ProductModel>("Product", productSchema);

export default Product;
