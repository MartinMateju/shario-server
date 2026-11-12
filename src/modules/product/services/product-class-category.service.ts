import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";
import type { ClientSession } from "mongoose";

import { PRODUCT_KIND, type ProductKind } from "../product-kind-v2.contract.js";
import {
  productClassCategoryRepository,
  type ProductClassCategoryRepository,
} from "../product-class-category.repository.js";
import type {
  ProductClassCategoryAttributes,
  ProductClassCategoryDto,
} from "../product-class-category.types.js";
import {
  getProductClassCategoryNameKey,
  normalizeProductClassCategoryName,
} from "../product-class-category.utils.js";
import type { CreateProductClassCategoryInput } from "../product-class-category.validators.js";

type StoredCategory = ProductClassCategoryAttributes & {
  _id: unknown;
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === 11000,
  );

const toDto = (
  category: StoredCategory,
  productCount: number,
): ProductClassCategoryDto => ({
  id: String(category._id),
  name: category.name,
  productCount,
  createdAt: category.createdAt,
  updatedAt: category.updatedAt,
});

const countByNameKey = (
  counts: Awaited<
    ReturnType<ProductClassCategoryRepository["listAssignedCategoryCounts"]>
  >,
): Map<string, number> => {
  const result = new Map<string, number>();

  for (const count of counts) {
    const nameKey = getProductClassCategoryNameKey(count.name);
    result.set(nameKey, (result.get(nameKey) ?? 0) + count.productCount);
  }

  return result;
};

export const createProductClassCategoryService = (
  repository: ProductClassCategoryRepository = productClassCategoryRepository,
) => ({
  async list(
    tenantId: string,
  ): Promise<{ categories: ProductClassCategoryDto[] }> {
    const [categories, assignedCounts] = await Promise.all([
      repository.list(tenantId),
      repository.listAssignedCategoryCounts(tenantId),
    ]);
    const counts = countByNameKey(assignedCounts);

    return {
      categories: categories.map((category) =>
        toDto(
          category as unknown as StoredCategory,
          Math.max(
            Number(category.productCount ?? 0),
            counts.get(category.nameKey) ?? 0,
          ),
        ),
      ),
    };
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateProductClassCategoryInput,
  ): Promise<ProductClassCategoryDto> {
    const name = normalizeProductClassCategoryName(input.name);
    const nameKey = getProductClassCategoryNameKey(name);

    try {
      const category = await repository.create({
        tenantId,
        createdBy,
        input: { name },
        nameKey,
      });

      return toDto(category as unknown as StoredCategory, 0);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        conflict({
          message: "A class category with this name already exists.",
          code: "PRODUCT_CLASS_CATEGORY_CONFLICT",
        });
      }

      throw error;
    }
  },

  async delete(
    tenantId: string,
    categoryId: string,
  ): Promise<ProductClassCategoryDto> {
    const category = await repository.findById(tenantId, categoryId);
    if (!category) {
      notFound({
        message: "Class category not found.",
        code: "PRODUCT_CLASS_CATEGORY_NOT_FOUND",
      });
    }

    const counts = countByNameKey(
      await repository.listAssignedCategoryCounts(tenantId),
    );
    const productCount = Math.max(
      Number(category.productCount ?? 0),
      counts.get(category.nameKey) ?? 0,
    );

    if (productCount > 0) {
      conflict({
        message:
          "This category is assigned to class products. Reassign them before deleting it.",
        code: "PRODUCT_CLASS_CATEGORY_IN_USE",
        details: { productCount },
      });
    }

    const deleted = await repository.deleteUnusedById(tenantId, categoryId);
    if (!deleted) {
      const current = await repository.findById(tenantId, categoryId);
      if (current) {
        conflict({
          message:
            "This category was assigned while it was being deleted. Reassign the class and try again.",
          code: "PRODUCT_CLASS_CATEGORY_IN_USE",
          details: { productCount: Number(current.productCount ?? 1) },
        });
      }

      notFound({
        message: "Class category not found.",
        code: "PRODUCT_CLASS_CATEGORY_NOT_FOUND",
      });
    }

    return toDto(deleted as unknown as StoredCategory, 0);
  },

  async resolveProductAssignment({
    tenantId,
    kind,
    value,
    existingValue,
  }: {
    tenantId: string;
    kind: ProductKind | null;
    value: string | undefined;
    existingValue?: string;
  }): Promise<string | undefined> {
    const name = normalizeProductClassCategoryName(value);

    if (kind !== PRODUCT_KIND.CLASS) {
      if (name) {
        badRequest({
          message: "Class categories can only be assigned to class products.",
          code: "PRODUCT_CLASS_CATEGORY_NOT_ALLOWED",
        });
      }

      return value === undefined && !existingValue ? undefined : "";
    }

    if (value === undefined) return undefined;
    if (!name) return "";

    const nameKey = getProductClassCategoryNameKey(name);
    const category = await repository.findByNameKey(tenantId, nameKey);

    if (category) return category.name;

    // Preserve a historical free-text assignment while the additive category
    // backfill is being rolled out. Any newly selected value must be managed.
    if (
      existingValue &&
      getProductClassCategoryNameKey(existingValue) === nameKey
    ) {
      return normalizeProductClassCategoryName(existingValue);
    }

    badRequest({
      message: "Select a class category from this workspace.",
      code: "PRODUCT_CLASS_CATEGORY_NOT_FOUND",
    });
  },

  async claimProductAssignment(
    tenantId: string,
    name: string,
    session?: ClientSession | null,
  ): Promise<string> {
    const category = await repository.claimAssignment(
      tenantId,
      getProductClassCategoryNameKey(name),
      session,
    );
    if (!category) {
      badRequest({
        message: "Select a class category from this workspace.",
        code: "PRODUCT_CLASS_CATEGORY_NOT_FOUND",
      });
    }

    return category.name;
  },

  async releaseProductAssignment(
    tenantId: string,
    name: string | undefined,
    session?: ClientSession | null,
  ): Promise<void> {
    const nameKey = getProductClassCategoryNameKey(name);
    if (!nameKey) return;
    await repository.releaseAssignment(tenantId, nameKey, session);
  },
});

export const productClassCategoryService = createProductClassCategoryService();
