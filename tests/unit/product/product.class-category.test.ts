import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  MAX_PRODUCT_CLASS_CATEGORY_LENGTH,
} from "@/modules/product/product.constants.js";
import { productSchema } from "@/modules/product/product.schema.js";
import {
  toProductCatalogDto,
  toProductPublicDto,
} from "@/modules/product/product.utils.js";
import {
  createProductSchema,
  updateProductSchema,
} from "@/modules/product/product.validators.js";

const productRecord = (overrides: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  name: "Wheel basics",
  description: "Learn the pottery wheel",
  classCategory: "Pottery wheel",
  sku: "",
  type: "course",
  kind: "class",
  kindContractVersion: 2,
  bookingMode: null,
  price: 2400,
  extraCharge: 0,
  maxNumberOfParticipants: 4,
  currency: "CZK",
  imageSrc: "",
  label: "",
  voucherTemplate: "",
  couponProduct: null,
  studioFlow: undefined,
  isActive: true,
  sortOrder: 0,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  ...overrides,
});

describe("product class category", () => {
  it("persists a trimmed optional category with a blank storage default", () => {
    const schemaPath = productSchema.path("classCategory");

    expect(schemaPath).toBeDefined();
    expect((schemaPath as any)?.options).toMatchObject({
      default: "",
      maxlength: MAX_PRODUCT_CLASS_CATEGORY_LENGTH,
      trim: true,
    });

    expect(
      createProductSchema.parse({
        name: "Wheel basics",
        kind: "class",
        classCategory: "  Pottery wheel  ",
        price: 2400,
        maxNumberOfParticipants: 4,
      }).classCategory,
    ).toBe("Pottery wheel");

    expect(
      createProductSchema.parse({
        name: "Wheel basics",
        kind: "class",
        price: 2400,
        maxNumberOfParticipants: 4,
      }),
    ).not.toHaveProperty("classCategory");
  });

  it("validates updates without resetting an omitted category", () => {
    const id = new mongoose.Types.ObjectId().toString();
    const update = updateProductSchema.parse({
      id,
      classCategory: "  Modelling  ",
    });
    const updateWithoutCategory = updateProductSchema.parse({
      id,
      name: "Renamed class",
    });

    expect(update.classCategory).toBe("Modelling");
    expect(updateWithoutCategory).not.toHaveProperty("classCategory");

    const invalid = updateProductSchema.safeParse({
      id,
      classCategory: "x".repeat(MAX_PRODUCT_CLASS_CATEGORY_LENGTH + 1),
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.flatten().fieldErrors.classCategory).toBeDefined();
    }
  });

  it("exposes the class category through internal and public catalog DTOs", () => {
    const product = productRecord();

    expect(toProductPublicDto(product as never)).toMatchObject({
      classCategory: "Pottery wheel",
    });
    expect(toProductCatalogDto(product as never)).toMatchObject({
      classCategory: "Pottery wheel",
    });
  });

  it("serializes historical products without a category as a blank string", () => {
    const product = productRecord({ classCategory: undefined });

    expect(toProductPublicDto(product as never).classCategory).toBe("");
    expect(toProductCatalogDto(product as never).classCategory).toBe("");
  });
});
