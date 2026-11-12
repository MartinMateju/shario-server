import { describe, expect, it } from "vitest";

import {
  getProductClassCategoryNameKey,
  normalizeProductClassCategoryName,
} from "@/modules/product/product-class-category.utils.js";
import {
  createProductClassCategorySchema,
  productClassCategoryParamsSchema,
} from "@/modules/product/product-class-category.validators.js";

describe("product class category validation", () => {
  it("trims and bounds category names", () => {
    expect(
      createProductClassCategorySchema.parse({ name: "  Wheel throwing  " }),
    ).toEqual({ name: "Wheel throwing" });
    expect(() =>
      createProductClassCategorySchema.parse({ name: " " }),
    ).toThrow();
    expect(() =>
      createProductClassCategorySchema.parse({ name: "a".repeat(121) }),
    ).toThrow();
    expect(() =>
      createProductClassCategorySchema.parse({ name: "\u0301\u200b" }),
    ).toThrow();
  });

  it("requires a valid category id in route parameters", () => {
    expect(
      productClassCategoryParamsSchema.parse({
        categoryId: "507f1f77bcf86cd799439011",
      }),
    ).toEqual({ categoryId: "507f1f77bcf86cd799439011" });
    expect(() =>
      productClassCategoryParamsSchema.parse({ categoryId: "foreign" }),
    ).toThrow();
  });

  it("uses a locale-neutral key for public-filter-equivalent names", () => {
    expect(normalizeProductClassCategoryName("  Wheel   throwing  ")).toBe(
      "Wheel throwing",
    );
    expect(getProductClassCategoryNameKey("Glazování")).toBe("glazovani");
    expect(getProductClassCategoryNameKey("  GLAZOVANI ")).toBe("glazovani");
  });
});
