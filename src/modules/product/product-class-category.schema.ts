import mongoose from "mongoose";

import { MAX_PRODUCT_CLASS_CATEGORY_LENGTH } from "./product.constants.js";
import type {
  ProductClassCategoryAttributes,
  ProductClassCategoryModel,
} from "./product-class-category.types.js";
import {
  getProductClassCategoryNameKey,
  hasVisibleProductClassCategoryName,
  normalizeProductClassCategoryName,
} from "./product-class-category.utils.js";

export const productClassCategorySchema = new mongoose.Schema<
  ProductClassCategoryAttributes,
  ProductClassCategoryModel
>(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: MAX_PRODUCT_CLASS_CATEGORY_LENGTH,
      set: normalizeProductClassCategoryName,
      validate: {
        validator: hasVisibleProductClassCategoryName,
        message: "Category name must contain a visible character.",
      },
    },
    nameKey: {
      type: String,
      required: true,
      maxlength: MAX_PRODUCT_CLASS_CATEGORY_LENGTH,
    },
    productCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

productClassCategorySchema.pre("validate", function setNameKey() {
  this.name = normalizeProductClassCategoryName(this.name);
  this.nameKey = getProductClassCategoryNameKey(this.name);
});

productClassCategorySchema.index(
  { tenant: 1, nameKey: 1 },
  { unique: true, name: "tenant_1_product_class_category_name_key_1" },
);
productClassCategorySchema.index({ tenant: 1, name: 1 });
