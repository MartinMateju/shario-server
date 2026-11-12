import { beforeEach, describe, expect, it, vi } from "vitest";

import { createProductClassCategoryService } from "@/modules/product/services/product-class-category.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const actorId = "507f1f77bcf86cd799439012";
const categoryId = "507f1f77bcf86cd799439013";
const otherTenantId = "507f1f77bcf86cd799439099";
const now = new Date("2026-08-28T12:00:00.000Z");

const category = (overrides = {}) => ({
  _id: categoryId,
  tenant: tenantId,
  createdBy: actorId,
  name: "Wheel throwing",
  nameKey: "wheel throwing",
  productCount: 0,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const repository = {
  list: vi.fn(),
  findById: vi.fn(),
  findByNameKey: vi.fn(),
  create: vi.fn(),
  deleteUnusedById: vi.fn(),
  claimAssignment: vi.fn(),
  releaseAssignment: vi.fn(),
  listAssignedCategoryCounts: vi.fn(),
};

const service = createProductClassCategoryService(repository as never);

describe("product class category service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.list.mockResolvedValue([]);
    repository.findById.mockResolvedValue(null);
    repository.findByNameKey.mockResolvedValue(null);
    repository.listAssignedCategoryCounts.mockResolvedValue([]);
  });

  it("lists tenant categories with normalized assignment counts", async () => {
    repository.list.mockResolvedValueOnce([
      category(),
      category({
        _id: "507f1f77bcf86cd799439014",
        name: "Glazování",
        nameKey: "glazovani",
      }),
    ]);
    repository.listAssignedCategoryCounts.mockResolvedValueOnce([
      { name: "Wheel throwing", productCount: 2 },
      { name: "GLAZOVANI", productCount: 1 },
    ]);

    await expect(service.list(tenantId)).resolves.toEqual({
      categories: [
        expect.objectContaining({
          id: categoryId,
          name: "Wheel throwing",
          productCount: 2,
        }),
        expect.objectContaining({
          name: "Glazování",
          productCount: 1,
        }),
      ],
    });
    expect(repository.list).toHaveBeenCalledWith(tenantId);
    expect(repository.listAssignedCategoryCounts).toHaveBeenCalledWith(
      tenantId,
    );
  });

  it("creates normalized tenant-owned categories and maps duplicates to 409", async () => {
    repository.create.mockResolvedValueOnce(category());

    await expect(
      service.create(tenantId, actorId, { name: "  Wheel   throwing " }),
    ).resolves.toMatchObject({
      id: categoryId,
      name: "Wheel throwing",
      productCount: 0,
    });
    expect(repository.create).toHaveBeenCalledWith({
      tenantId,
      createdBy: actorId,
      input: { name: "Wheel throwing" },
      nameKey: "wheel throwing",
    });

    repository.create.mockRejectedValueOnce({ code: 11000 });
    await expect(
      service.create(tenantId, actorId, { name: "WHEEL THROWING" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PRODUCT_CLASS_CATEGORY_CONFLICT",
    });
  });

  it("protects an assigned category from deletion", async () => {
    repository.findById.mockResolvedValueOnce(category());
    repository.listAssignedCategoryCounts.mockResolvedValueOnce([
      { name: "wheel throwing", productCount: 3 },
    ]);

    await expect(service.delete(tenantId, categoryId)).rejects.toMatchObject({
      statusCode: 409,
      code: "PRODUCT_CLASS_CATEGORY_IN_USE",
      details: { productCount: 3 },
    });
    expect(repository.deleteUnusedById).not.toHaveBeenCalled();
  });

  it("deletes only an unused category in the current tenant", async () => {
    repository.findById.mockResolvedValueOnce(category());
    repository.deleteUnusedById.mockResolvedValueOnce(category());

    await expect(service.delete(tenantId, categoryId)).resolves.toMatchObject({
      id: categoryId,
      productCount: 0,
    });
    expect(repository.deleteUnusedById).toHaveBeenCalledWith(
      tenantId,
      categoryId,
    );

    await expect(
      service.delete(otherTenantId, categoryId),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PRODUCT_CLASS_CATEGORY_NOT_FOUND",
    });
  });

  it("rejects deletion when an assignment wins the atomic delete race", async () => {
    repository.findById
      .mockResolvedValueOnce(category())
      .mockResolvedValueOnce(category({ productCount: 1 }));
    repository.deleteUnusedById.mockResolvedValueOnce(null);

    await expect(service.delete(tenantId, categoryId)).rejects.toMatchObject({
      statusCode: 409,
      code: "PRODUCT_CLASS_CATEGORY_IN_USE",
      details: { productCount: 1 },
    });
  });

  it("claims and releases assignments through the caller transaction", async () => {
    const session = { transaction: true } as never;
    repository.claimAssignment.mockResolvedValueOnce(
      category({ productCount: 1 }),
    );
    repository.releaseAssignment.mockResolvedValueOnce(category());

    await expect(
      service.claimProductAssignment(tenantId, "Wheel throwing", session),
    ).resolves.toBe("Wheel throwing");
    await service.releaseProductAssignment(tenantId, "Wheel throwing", session);

    expect(repository.claimAssignment).toHaveBeenCalledWith(
      tenantId,
      "wheel throwing",
      session,
    );
    expect(repository.releaseAssignment).toHaveBeenCalledWith(
      tenantId,
      "wheel throwing",
      session,
    );
  });

  it("resolves only managed class assignments and preserves unchanged legacy text", async () => {
    repository.findByNameKey.mockResolvedValueOnce(category());

    await expect(
      service.resolveProductAssignment({
        tenantId,
        kind: "class",
        value: "WHEEL THROWING",
      }),
    ).resolves.toBe("Wheel throwing");
    expect(repository.findByNameKey).toHaveBeenCalledWith(
      tenantId,
      "wheel throwing",
    );

    await expect(
      service.resolveProductAssignment({
        tenantId,
        kind: "class",
        value: "Legacy category",
        existingValue: "Legacy category",
      }),
    ).resolves.toBe("Legacy category");

    await expect(
      service.resolveProductAssignment({
        tenantId,
        kind: "class",
        value: "Unknown category",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PRODUCT_CLASS_CATEGORY_NOT_FOUND",
    });
  });

  it("clears stale assignments on kind changes and rejects new non-class assignments", async () => {
    await expect(
      service.resolveProductAssignment({
        tenantId,
        kind: "voucher",
        value: undefined,
        existingValue: "Wheel throwing",
      }),
    ).resolves.toBe("");

    await expect(
      service.resolveProductAssignment({
        tenantId,
        kind: "open-studio",
        value: "Wheel throwing",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PRODUCT_CLASS_CATEGORY_NOT_ALLOWED",
    });
  });
});
