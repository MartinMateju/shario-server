import mongoose, { type ClientSession } from "mongoose";

import { Product } from "./product.model.js";
import { ProductClassCategoryModel } from "./product-class-category.model.js";
import { COURSE_PRODUCT_TYPES } from "./product.constants.js";
import { PRODUCT_KIND } from "./product-kind-v2.contract.js";
import type { CreateProductClassCategoryInput } from "./product-class-category.validators.js";

const toObjectId = (value: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(value);

export type AssignedClassCategoryCount = {
  name: string;
  productCount: number;
};

export const productClassCategoryRepository = {
  list(tenantId: string) {
    return ProductClassCategoryModel.find({ tenant: toObjectId(tenantId) })
      .sort({ name: 1, createdAt: 1 })
      .collation({ locale: "en", strength: 2 })
      .lean()
      .exec();
  },

  findById(tenantId: string, categoryId: string) {
    return ProductClassCategoryModel.findOne({
      _id: toObjectId(categoryId),
      tenant: toObjectId(tenantId),
    })
      .lean()
      .exec();
  },

  findByNameKey(tenantId: string, nameKey: string) {
    return ProductClassCategoryModel.findOne({
      tenant: toObjectId(tenantId),
      nameKey,
    })
      .lean()
      .exec();
  },

  claimAssignment(
    tenantId: string,
    nameKey: string,
    session?: ClientSession | null,
  ) {
    return ProductClassCategoryModel.findOneAndUpdate(
      {
        tenant: toObjectId(tenantId),
        nameKey,
      },
      { $inc: { productCount: 1 } },
      {
        returnDocument: "after",
        runValidators: true,
        ...(session ? { session } : {}),
      },
    )
      .lean()
      .exec();
  },

  releaseAssignment(
    tenantId: string,
    nameKey: string,
    session?: ClientSession | null,
  ) {
    return ProductClassCategoryModel.findOneAndUpdate(
      {
        tenant: toObjectId(tenantId),
        nameKey,
        productCount: { $gt: 0 },
      },
      { $inc: { productCount: -1 } },
      {
        returnDocument: "after",
        runValidators: true,
        ...(session ? { session } : {}),
      },
    )
      .lean()
      .exec();
  },

  async create({
    tenantId,
    createdBy,
    input,
    nameKey,
  }: {
    tenantId: string;
    createdBy: string;
    input: CreateProductClassCategoryInput;
    nameKey: string;
  }) {
    const category = await ProductClassCategoryModel.create({
      tenant: toObjectId(tenantId),
      createdBy: toObjectId(createdBy),
      name: input.name,
      nameKey,
    });

    return category.toObject();
  },

  deleteUnusedById(tenantId: string, categoryId: string) {
    return ProductClassCategoryModel.findOneAndDelete({
      _id: toObjectId(categoryId),
      tenant: toObjectId(tenantId),
      productCount: 0,
    })
      .lean()
      .exec();
  },

  listAssignedCategoryCounts(
    tenantId: string,
  ): Promise<AssignedClassCategoryCount[]> {
    return Product.aggregate<{
      _id: string;
      productCount: number;
    }>([
      {
        $match: {
          tenant: toObjectId(tenantId),
          classCategory: { $type: "string", $ne: "" },
          $or: [
            { kind: PRODUCT_KIND.CLASS },
            {
              kind: { $exists: false },
              type: { $in: COURSE_PRODUCT_TYPES },
            },
            {
              kind: { $in: [null, ""] },
              type: { $in: COURSE_PRODUCT_TYPES },
            },
          ],
        },
      },
      {
        $group: {
          _id: "$classCategory",
          productCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
      .exec()
      .then((counts) =>
        counts.map((count) => ({
          name: String(count._id),
          productCount: Number(count.productCount),
        })),
      );
  },
};

export type ProductClassCategoryRepository =
  typeof productClassCategoryRepository;
