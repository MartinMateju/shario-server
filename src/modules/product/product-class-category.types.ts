import type { HydratedDocument, Model, Types } from "mongoose";

export type ProductClassCategoryAttributes = {
  tenant: Types.ObjectId;
  name: string;
  nameKey: string;
  productCount: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductClassCategoryDocument =
  HydratedDocument<ProductClassCategoryAttributes>;

export type ProductClassCategoryModel = Model<ProductClassCategoryAttributes>;

export type ProductClassCategoryDto = {
  id: string;
  name: string;
  productCount: number;
  createdAt: Date;
  updatedAt: Date;
};
