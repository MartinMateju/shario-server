import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const piecePricingProfileExistsExec = vi.fn();
  const repository = {
    count: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    updateById: vi.fn(),
  };

  return {
    locationFind: vi.fn(),
    locationExistsExec: vi.fn(),
    acquireVoucherTenantMutationLock: vi.fn(),
    assertVoucherOfferingPublicationAllowed: vi.fn(),
    getVoucherOfferingDeletionPolicy: vi.fn(),
    assertVoucherOfferingDeletable: vi.fn(),
    preserveLegacyVoucherValuesBeforeDeletion: vi.fn(),
    prepareVoucherDesign: vi.fn(),
    createProductRepository: vi.fn(() => repository),
    getTenantOrThrow: vi.fn(),
    piecePricingProfileExists: vi.fn(() => ({
      exec: piecePricingProfileExistsExec,
    })),
    piecePricingProfileExistsExec,
    repository,
    deleteUploadedProductImage: vi.fn(),
    uploadProductImage: vi.fn(),
    uploadBufferToR2: vi.fn(),
    resolveProductClassCategory: vi.fn(),
    claimProductClassCategory: vi.fn(),
    releaseProductClassCategory: vi.fn(),
    withProductClassCategoryTransaction: vi.fn(),
  };
});

vi.mock("@/modules/location/location.model.js", () => ({
  default: { find: mocks.locationFind },
}));

vi.mock("@/modules/product/voucher-offering.policy.js", () => ({
  acquireVoucherTenantMutationLock: mocks.acquireVoucherTenantMutationLock,
  assertVoucherOfferingPublicationAllowed: mocks.assertVoucherOfferingPublicationAllowed,
  getVoucherOfferingDeletionPolicy: mocks.getVoucherOfferingDeletionPolicy,
  assertVoucherOfferingDeletable: mocks.assertVoucherOfferingDeletable,
  preserveLegacyVoucherValuesBeforeDeletion: mocks.preserveLegacyVoucherValuesBeforeDeletion,
}));

vi.mock("@/modules/product/product.repository.js", () => ({
  createProductRepository: mocks.createProductRepository,
}));

vi.mock("@/modules/product/services/voucher-design.service.js", () => ({
  prepareVoucherDesign: mocks.prepareVoucherDesign,
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));

vi.mock("@/modules/piece-pricing/piece-pricing-profile.model.js", () => ({
  PiecePricingProfileModel: {
    exists: mocks.piecePricingProfileExists,
  },
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  uploadBufferToR2: mocks.uploadBufferToR2,
}));

vi.mock("@/modules/product/services/product-image.service.js", () => ({
  deleteUploadedProductImage: mocks.deleteUploadedProductImage,
  uploadProductImage: mocks.uploadProductImage,
}));

vi.mock("@/modules/product/services/product-class-category.service.js", () => ({
  productClassCategoryService: {
    resolveProductAssignment: mocks.resolveProductClassCategory,
    claimProductAssignment: mocks.claimProductClassCategory,
    releaseProductAssignment: mocks.releaseProductClassCategory,
  },
}));

vi.mock("@/modules/product/product-class-category.transaction.js", () => ({
  withProductClassCategoryTransaction:
    mocks.withProductClassCategoryTransaction,
}));

import {
  PUBLIC_COURSE_PRODUCT_TYPES,
  PUBLIC_PRODUCT_TYPES,
} from "@/modules/product/product.constants.js";
import { productService } from "@/modules/product/services/product.service.js";
import type { CreateProductInput } from "@/modules/product/product.validators.js";
import { DEFAULT_VOUCHER_DESIGN } from "@/modules/coupon/voucher-design.js";

const tenantId = "507f1f77bcf86cd799439011";
const userId = "507f1f77bcf86cd799439012";
const locationId = "507f1f77bcf86cd799439013";
const uploadedImage = {
  originalname: "class.png",
  mimetype: "image/png",
  size: 5,
  buffer: Buffer.from("image"),
};

const classProductInput = (): CreateProductInput => ({
  name: "Wheel class",
  description: "",
  sku: "",
  kind: "class",
  price: 900,
  extraCharge: 0,
  maxNumberOfParticipants: 8,
  imageSrc: "",
  label: "",
  voucherTemplate: "",
  isActive: true,
  sortOrder: 0,
});

const productDocument = (overrides: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant: new mongoose.Types.ObjectId(tenantId),
  createdBy: new mongoose.Types.ObjectId(userId),
  name: "Open studio",
  description: "Customer-facing description",
  classCategory: "",
  sku: "INTERNAL-SKU",
  type: "workshop",
  kind: "open-studio",
  kindContractVersion: 2,
  bookingMode: "public",
  price: 450,
  extraCharge: 0,
  maxNumberOfParticipants: 10,
  currency: "CZK",
  imageSrc: "https://cdn.example.test/open-studio.jpg",
  label: "internal-label",
  voucherTemplate: "private/template.pdf",
  couponProduct: null,
  isActive: true,
  sortOrder: 2,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-02T00:00:00.000Z"),
  ...overrides,
});

describe("productService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.locationFind.mockReturnValue({ distinct: () => ({ exec: mocks.locationExistsExec }) });
    mocks.locationExistsExec.mockReset().mockResolvedValue([new mongoose.Types.ObjectId(locationId)]);
    mocks.prepareVoucherDesign.mockReset().mockImplementation(async (_tenantId, design) => structuredClone(design));
    mocks.acquireVoucherTenantMutationLock.mockReset().mockResolvedValue({ plan: "starter", voucherQuotaVersion: 1 });
    mocks.assertVoucherOfferingPublicationAllowed.mockReset().mockResolvedValue(undefined);
    mocks.getVoucherOfferingDeletionPolicy.mockReset().mockResolvedValue({ canDelete: true, reason: null, unexpiredCodeCount: 0, perpetualCodeCount: 0, pendingOrderCount: 0, requiresConfirmation: false });
    mocks.assertVoucherOfferingDeletable.mockReset();
    mocks.preserveLegacyVoucherValuesBeforeDeletion.mockReset().mockResolvedValue(undefined);
    for (const method of Object.values(mocks.repository)) {
      method.mockReset();
    }
    mocks.createProductRepository.mockReset();
    mocks.createProductRepository.mockReturnValue(mocks.repository);
    mocks.getTenantOrThrow.mockReset();
    mocks.piecePricingProfileExistsExec.mockReset();
    mocks.deleteUploadedProductImage.mockReset();
    mocks.uploadProductImage.mockReset();
    mocks.uploadBufferToR2.mockReset();
    mocks.resolveProductClassCategory.mockReset();
    mocks.claimProductClassCategory.mockReset();
    mocks.claimProductClassCategory.mockImplementation(
      (_tenantId: string, name: string) => Promise.resolve(name),
    );
    mocks.releaseProductClassCategory.mockReset();
    mocks.withProductClassCategoryTransaction.mockReset();
    mocks.withProductClassCategoryTransaction.mockImplementation((operation) =>
      operation({ transaction: true }),
    );
    mocks.resolveProductClassCategory.mockImplementation(
      ({
        kind,
        value,
        existingValue,
      }: {
        kind: string | null;
        value?: string;
        existingValue?: string;
      }) =>
        Promise.resolve(
          kind === "class"
            ? value
            : value === undefined && !existingValue
              ? undefined
              : "",
        ),
    );
    mocks.deleteUploadedProductImage.mockResolvedValue(true);
    mocks.uploadProductImage.mockResolvedValue({
      key: `tenants/${tenantId}/products/new.png`,
      url: `https://media.shario.test/tenants/${tenantId}/products/new.png`,
    });
    mocks.getTenantOrThrow.mockResolvedValue({
      _id: tenantId,
      settings: { currency: "CZK" },
      modules: {
        payments: true,
        bookings: true,
        courses: true,
        vouchers: true,
      },
    });
    mocks.repository.list.mockResolvedValue([]);
    mocks.repository.findOne.mockResolvedValue(null);
    mocks.repository.count.mockResolvedValue(0);
    mocks.piecePricingProfileExistsExec.mockResolvedValue({ _id: "profile" });
  });

  it("validates course publication locations against tenant ownership before create or update", async () => {
    const content = { name: {}, description: {}, details: {}, durationLabel: {}, images: [], locationIds: [locationId] };
    mocks.locationExistsExec.mockResolvedValue([]);
    await expect(productService.createProduct({ tenantId, createdBy: userId, input: { ...classProductInput(), courseContent: content } })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.repository.create).not.toHaveBeenCalled();
    mocks.repository.findById.mockResolvedValue(productDocument());
    await expect(productService.updateProduct({ tenantId, input: { id: "507f1f77bcf86cd799439014", courseContent: content } })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.repository.update).not.toHaveBeenCalled();
    expect(mocks.locationFind).toHaveBeenCalledWith({ _id: { $in: [locationId] }, tenant: tenantId });
  });

  it("creates customer-choice products with safe defaults", async () => {
    mocks.repository.create.mockImplementationOnce(async (_createdBy, input) => productDocument(input));
    const result = await productService.createProduct({
      tenantId, createdBy: userId,
      input: { ...classProductInput(), kind: "open-studio", bookingMode: "customer-choice", locationId },
    });
    expect(result.openStudioPolicy).toEqual({
      publicCapacityMode: "activity", publicCapacityLimit: null, privateBookingSurcharge: 0,
    });
  });

  it("merges partial sharing-policy updates without dropping capacity", async () => {
    const existing = productDocument({
      bookingMode: "customer-choice",
      openStudioPolicy: { publicCapacityMode: "fixed", publicCapacityLimit: 2, privateBookingSurcharge: 50 },
    });
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.update.mockImplementationOnce(async (input) => ({ ...existing, ...input }));
    const result = await productService.updateProduct({
      tenantId, input: { id: String(existing._id), openStudioPolicy: { privateBookingSurcharge: 100 } },
    });
    expect(result.openStudioPolicy).toEqual({
      publicCapacityMode: "fixed", publicCapacityLimit: 2, privateBookingSurcharge: 100,
    });
  });

  it("clears the fixed limit when switching to activity capacity", async () => {
    const existing = productDocument({
      bookingMode: "customer-choice",
      openStudioPolicy: { publicCapacityMode: "fixed", publicCapacityLimit: 2, privateBookingSurcharge: 50 },
    });
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.update.mockImplementationOnce(async (input) => ({ ...existing, ...input }));
    const result = await productService.updateProduct({
      tenantId, input: { id: String(existing._id), openStudioPolicy: { publicCapacityMode: "activity" } },
    });
    expect(result.openStudioPolicy).toEqual({
      publicCapacityMode: "activity", publicCapacityLimit: null, privateBookingSurcharge: 50,
    });
  });

  it.each([
    { publicCapacityMode: "fixed" },
    { publicCapacityMode: "fixed", publicCapacityLimit: 0 },
    { publicCapacityMode: "fixed", publicCapacityLimit: 1.5 },
    { privateBookingSurcharge: -1 },
  ])("rejects invalid merged sharing policy %j", async (openStudioPolicy) => {
    const existing = productDocument({ bookingMode: "customer-choice" });
    mocks.repository.findById.mockResolvedValue(existing);
    await expect(productService.updateProduct({
      tenantId, input: { id: String(existing._id), openStudioPolicy } as never,
    })).rejects.toMatchObject({ code: "INVALID_OPEN_STUDIO_POLICY" });
    expect(mocks.repository.update).not.toHaveBeenCalled();
  });

  it("enforces currency precision on the private surcharge", async () => {
    const existing = productDocument({ bookingMode: "customer-choice" });
    mocks.repository.findById.mockResolvedValue(existing);
    await expect(productService.updateProduct({
      tenantId, input: { id: String(existing._id), openStudioPolicy: { privateBookingSurcharge: 0.001 } },
    })).rejects.toMatchObject({ code: "INVALID_CURRENCY_PRECISION" });
  });

  it("rejects sharing policies on non-choice products and clears them when leaving choice", async () => {
    const existing = productDocument({
      bookingMode: "customer-choice",
      openStudioPolicy: { publicCapacityMode: "fixed", publicCapacityLimit: 2, privateBookingSurcharge: 50 },
    });
    mocks.repository.findById.mockResolvedValue(existing);
    await expect(productService.updateProduct({
      tenantId,
      input: { id: String(existing._id), bookingMode: "public", openStudioPolicy: { privateBookingSurcharge: 100 } },
    })).rejects.toMatchObject({ code: "OPEN_STUDIO_POLICY_NOT_ALLOWED" });
    mocks.repository.update.mockImplementationOnce(async (input) => ({ ...existing, ...input }));
    const result = await productService.updateProduct({
      tenantId, input: { id: String(existing._id), bookingMode: "public" },
    });
    expect(result.openStudioPolicy).toBeNull();
    expect(mocks.repository.update).toHaveBeenCalledWith(expect.objectContaining({ openStudioPolicy: null }));
  });

  it("scopes the public catalog to active, explicitly public product types", async () => {
    mocks.repository.list.mockResolvedValueOnce([productDocument()]);
    mocks.repository.count.mockResolvedValueOnce(1);

    const result = await productService.listPublicProducts({
      tenantId,
      search: "studio",
      page: 1,
      limit: 20,
    });

    expect(mocks.createProductRepository).toHaveBeenCalledWith({
      tenantId,
    });
    expect(mocks.repository.list).toHaveBeenCalledWith({
      types: PUBLIC_PRODUCT_TYPES,
      assignedStudioOnly: true,
      isActive: true,
      search: "studio",
      page: 1,
      limit: 20,
    });
    expect(mocks.repository.count).toHaveBeenCalledWith({
      types: PUBLIC_PRODUCT_TYPES,
      assignedStudioOnly: true,
      isActive: true,
      search: "studio",
      page: 1,
      limit: 20,
    });
    expect(PUBLIC_PRODUCT_TYPES).not.toContain("system");
    expect(PUBLIC_PRODUCT_TYPES).not.toContain("private-course");
    expect(PUBLIC_PRODUCT_TYPES).toContain("private-workshop");
    expect(result.products[0]).toEqual({
      id: expect.any(String),
      _id: expect.any(String),
      locationId: null,
      name: "Open studio",
      description: "Customer-facing description",
      classCategory: "",
      type: "workshop",
      kind: "open-studio",
      kindContractVersion: 2,
      bookingMode: "public",
      openStudioPolicy: null,
      price: 450,
      extraCharge: 0,
      maxNumberOfParticipants: 10,
      currency: "CZK",
      imageSrc: "https://cdn.example.test/open-studio.jpg",
      isActive: true,
    });
    expect(result.products[0]).not.toHaveProperty("sku");
    expect(result.products[0]).not.toHaveProperty("label");
    expect(result.products[0]).not.toHaveProperty("voucherTemplate");
    expect(result.products[0]).not.toHaveProperty("couponProduct");
  });

  it("includes canonical and public legacy courses but not private courses publicly", async () => {
    await productService.listPublicProducts({
      tenantId,
      coursesOnly: true,
    });

    expect(mocks.repository.list).toHaveBeenCalledWith(
      expect.objectContaining({
        types: PUBLIC_COURSE_PRODUCT_TYPES,
        isActive: true,
      }),
    );
    expect(PUBLIC_COURSE_PRODUCT_TYPES).toContain("public-course");
    expect(PUBLIC_COURSE_PRODUCT_TYPES).not.toContain("private-course");
  });

  it("never allows tenant CRUD to create a system product", async () => {
    await expect(
      productService.createProduct({
        tenantId,
        createdBy: userId,
        input: {
          name: "Internal fee",
          description: "",
          sku: "",
          type: "system",
          price: 0,
          extraCharge: 0,
          maxNumberOfParticipants: null,
          imageSrc: "",
          label: "",
          voucherTemplate: "",
          isActive: true,
          sortOrder: 0,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SYSTEM_PRODUCT_IMMUTABLE",
    });
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("persists the canonical Open Studio kind, fixed mode, and legacy projection", async () => {
    mocks.repository.create.mockImplementationOnce(async (_createdBy, input) =>
      productDocument(input),
    );

    const result = await productService.createProduct({
      tenantId,
      createdBy: userId,
      input: {
        name: "Private wheel room",
        locationId,
        description: "",
        sku: "",
        kind: "open-studio",
        bookingMode: "private",
        price: 900,
        extraCharge: 0,
        maxNumberOfParticipants: 4,
        imageSrc: "",
        label: "",
        voucherTemplate: "",
        isActive: true,
        sortOrder: 0,
      },
    });

    expect(mocks.repository.create).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        kind: "open-studio",
        kindContractVersion: 2,
        bookingMode: "private",
        type: "workshop",
      }),
    );
    expect(result).toMatchObject({
      kind: "open-studio",
      kindContractVersion: 2,
      bookingMode: "private",
      type: "workshop",
    });
  });

  it("persists the tenant-managed category canonicalized by the category service", async () => {
    mocks.resolveProductClassCategory.mockResolvedValueOnce("Wheel throwing");
    mocks.repository.create.mockImplementationOnce(async (_createdBy, input) =>
      productDocument(input),
    );

    await productService.createProduct({
      tenantId,
      createdBy: userId,
      input: {
        ...classProductInput(),
        classCategory: "wheel throwing",
      },
    });

    expect(mocks.resolveProductClassCategory).toHaveBeenCalledWith({
      tenantId,
      kind: "class",
      value: "wheel throwing",
    });
    expect(mocks.withProductClassCategoryTransaction).toHaveBeenCalledOnce();
    expect(mocks.claimProductClassCategory).toHaveBeenCalledWith(
      tenantId,
      "Wheel throwing",
      { transaction: true },
    );
    expect(mocks.createProductRepository).toHaveBeenCalledWith({
      tenantId,
      session: { transaction: true },
    });
    expect(mocks.repository.create).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ classCategory: "Wheel throwing" }),
    );
  });

  it("reassigns category counts in the same transaction as a product update", async () => {
    const existing = productDocument({
      type: "course",
      kind: "class",
      bookingMode: null,
      classCategory: "Wheel throwing",
    });
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.resolveProductClassCategory.mockResolvedValueOnce("Hand building");
    mocks.repository.update.mockImplementationOnce(async (input) => ({
      ...existing,
      ...input,
    }));

    await productService.updateProduct({
      tenantId,
      input: {
        id: String(existing._id),
        classCategory: "Hand building",
      },
    });

    expect(mocks.claimProductClassCategory).toHaveBeenCalledWith(
      tenantId,
      "Hand building",
      { transaction: true },
    );
    expect(mocks.releaseProductClassCategory).toHaveBeenCalledWith(
      tenantId,
      "Wheel throwing",
      { transaction: true },
    );
    expect(mocks.repository.update).toHaveBeenCalledWith(
      expect.objectContaining({ classCategory: "Hand building" }),
    );
  });

  it("re-reads the current category when Mongo retries an update transaction", async () => {
    const original = productDocument({
      type: "course",
      kind: "class",
      bookingMode: null,
      classCategory: "Wheel throwing",
    });
    const concurrentlyUpdated = {
      ...original,
      classCategory: "Modeling",
    };
    mocks.repository.findById
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(concurrentlyUpdated);
    mocks.resolveProductClassCategory.mockResolvedValueOnce("Hand building");
    mocks.repository.update.mockImplementation(async (input) => ({
      ...concurrentlyUpdated,
      ...input,
    }));
    mocks.withProductClassCategoryTransaction.mockImplementation(
      async (
        operation: (session: { transaction: boolean }) => Promise<unknown>,
      ) => {
        await operation({ transaction: true });
        return operation({ transaction: true });
      },
    );

    await productService.updateProduct({
      tenantId,
      input: {
        id: String(original._id),
        classCategory: "Hand building",
      },
    });

    expect(mocks.releaseProductClassCategory).toHaveBeenNthCalledWith(
      1,
      tenantId,
      "Wheel throwing",
      { transaction: true },
    );
    expect(mocks.releaseProductClassCategory).toHaveBeenNthCalledWith(
      2,
      tenantId,
      "Modeling",
      { transaction: true },
    );
  });

  it("releases the category count in the same transaction as product deletion", async () => {
    const existing = productDocument({
      type: "course",
      kind: "class",
      bookingMode: null,
      classCategory: "Wheel throwing",
    });
    mocks.repository.findById.mockResolvedValueOnce(existing);
    mocks.repository.delete.mockResolvedValueOnce(existing);

    await productService.deleteProduct({
      tenantId,
      productId: String(existing._id),
    });

    expect(mocks.releaseProductClassCategory).toHaveBeenCalledWith(
      tenantId,
      "Wheel throwing",
      { transaction: true },
    );
    expect(mocks.repository.delete).toHaveBeenCalledWith(String(existing._id));
  });

  it("does not count a stale category left on a non-class product", async () => {
    const existing = productDocument({
      type: "coupon",
      kind: "voucher",
      bookingMode: null,
      classCategory: "Wheel throwing",
    });
    mocks.repository.findById.mockResolvedValueOnce(existing);
    mocks.repository.delete.mockResolvedValueOnce(existing);

    await productService.deleteProduct({
      tenantId,
      productId: String(existing._id),
    });

    expect(mocks.releaseProductClassCategory).not.toHaveBeenCalled();
  });

  it("clears an uncounted stale category when a non-class product becomes a class", async () => {
    const existing = productDocument({
      type: "coupon",
      kind: "voucher",
      bookingMode: null,
      classCategory: "Wheel throwing",
    });
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.update.mockImplementationOnce(async (input) => ({
      ...existing,
      ...input,
    }));

    await productService.updateProduct({
      tenantId,
      input: { id: String(existing._id), kind: "class" },
    });

    expect(mocks.repository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "class",
        classCategory: "",
      }),
    );
    expect(mocks.claimProductClassCategory).not.toHaveBeenCalled();
    expect(mocks.releaseProductClassCategory).not.toHaveBeenCalled();
  });

  it("routes memberships to MembershipPlan instead of Product CRUD", async () => {
    await expect(
      productService.createProduct({
        tenantId,
        createdBy: userId,
        input: {
          name: "Monthly membership",
          description: "",
          sku: "",
          kind: "membership",
          price: 1500,
          extraCharge: 0,
          maxNumberOfParticipants: null,
          imageSrc: "",
          label: "",
          voucherTemplate: "",
          isActive: true,
          sortOrder: 0,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "MEMBERSHIP_PLAN_REQUIRED",
    });
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("keeps Private Studio internal and non-sellable", async () => {
    await expect(
      productService.createProduct({
        tenantId,
        createdBy: userId,
        input: {
          name: "Internal maintenance",
          description: "",
          sku: "",
          kind: "private-studio",
          price: 1,
          extraCharge: 0,
          maxNumberOfParticipants: null,
          imageSrc: "",
          label: "",
          voucherTemplate: "",
          isActive: true,
          sortOrder: 0,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PRIVATE_STUDIO_NOT_SELLABLE",
    });
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("allows an invalid legacy course to be deactivated but not reactivated", async () => {
    const existing = productDocument({
      type: "public-course",
      maxNumberOfParticipants: null,
      isActive: true,
    });
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.update.mockResolvedValue({
      ...existing,
      isActive: false,
    });

    await expect(
      productService.updateProduct({
        tenantId,
        input: {
          id: String(existing._id),
          isActive: false,
        },
      }),
    ).resolves.toMatchObject({
      isActive: false,
    });

    expect(mocks.repository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: String(existing._id),
        isActive: false,
      }),
    );

    mocks.repository.findById.mockResolvedValue({
      ...existing,
      isActive: false,
    });

    await expect(
      productService.updateProduct({
        tenantId,
        input: {
          id: String(existing._id),
          isActive: true,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PRODUCT_PARTICIPANT_CAPACITY_REQUIRED",
    });
  });

  it("rejects cross-tenant related product references", async () => {
    mocks.repository.findById.mockResolvedValueOnce(null);

    await expect(
      productService.createProduct({
        tenantId,
        createdBy: userId,
        input: {
          name: "Voucher",
          description: "",
          sku: "",
          type: "coupon",
          price: 500,
          extraCharge: 0,
          maxNumberOfParticipants: null,
          imageSrc: "",
          label: "Gift voucher",
          voucherTemplate: "",
          couponProduct: "507f1f77bcf86cd799439099",
          isActive: true,
          sortOrder: 0,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "RELATED_PRODUCT_NOT_FOUND",
    });
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("persists the uploaded product image URL instead of the submitted imageSrc", async () => {
    mocks.repository.create.mockImplementationOnce(async (_createdBy, input) =>
      productDocument(input),
    );

    const result = await productService.createProduct({
      tenantId,
      createdBy: userId,
      input: {
        ...classProductInput(),
        imageSrc: "https://legacy.example.test/class.jpg",
      },
      image: uploadedImage,
    });

    expect(mocks.uploadProductImage).toHaveBeenCalledWith({
      tenantId,
      file: uploadedImage,
    });
    expect(mocks.repository.create).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        imageSrc: `https://media.shario.test/tenants/${tenantId}/products/new.png`,
      }),
    );
    expect(result.imageSrc).toBe(
      `https://media.shario.test/tenants/${tenantId}/products/new.png`,
    );
  });

  it("preserves existing external imageSrc compatibility when no file is uploaded", async () => {
    const externalImage = "https://legacy.example.test/class.jpg";
    mocks.repository.create.mockImplementationOnce(async (_createdBy, input) =>
      productDocument(input),
    );

    const result = await productService.createProduct({
      tenantId,
      createdBy: userId,
      input: {
        ...classProductInput(),
        imageSrc: externalImage,
      },
    });

    expect(mocks.uploadProductImage).not.toHaveBeenCalled();
    expect(result.imageSrc).toBe(externalImage);
  });

  it("removes a newly uploaded image when product creation fails", async () => {
    const persistenceError = new Error("database unavailable");
    mocks.repository.create.mockRejectedValueOnce(persistenceError);

    await expect(
      productService.createProduct({
        tenantId,
        createdBy: userId,
        input: classProductInput(),
        image: uploadedImage,
      }),
    ).rejects.toBe(persistenceError);

    expect(mocks.deleteUploadedProductImage).toHaveBeenCalledWith({
      key: `tenants/${tenantId}/products/new.png`,
    });
  });

  it("replaces a product image without inferring ownership of the previous URL", async () => {
    const previousImageSrc = `https://media.shario.test/tenants/${tenantId}/products/old.png`;
    const existing = productDocument({
      type: "course",
      kind: "class",
      bookingMode: null,
      imageSrc: previousImageSrc,
    });
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.update.mockImplementationOnce(async (input) => ({
      ...existing,
      ...input,
    }));

    const result = await productService.updateProduct({
      tenantId,
      input: { id: String(existing._id) },
      image: uploadedImage,
    });

    expect(result.imageSrc).toBe(
      `https://media.shario.test/tenants/${tenantId}/products/new.png`,
    );
    expect(mocks.deleteUploadedProductImage).not.toHaveBeenCalled();
  });

  it("keeps the previous image and removes the replacement when update persistence fails", async () => {
    const previousImageSrc = `https://media.shario.test/tenants/${tenantId}/products/old.png`;
    const existing = productDocument({
      type: "course",
      kind: "class",
      bookingMode: null,
      imageSrc: previousImageSrc,
    });
    const persistenceError = new Error("database unavailable");
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.update.mockRejectedValueOnce(persistenceError);

    await expect(
      productService.updateProduct({
        tenantId,
        input: { id: String(existing._id) },
        image: uploadedImage,
      }),
    ).rejects.toBe(persistenceError);

    expect(mocks.deleteUploadedProductImage).toHaveBeenCalledOnce();
    expect(mocks.deleteUploadedProductImage).toHaveBeenCalledWith({
      key: `tenants/${tenantId}/products/new.png`,
    });
  });

  it("does not delete a stored URL without proof of exclusive ownership", async () => {
    const imageSrc = `https://media.shario.test/tenants/${tenantId}/products/deleted.png`;
    const existing = productDocument({ imageSrc });
    mocks.repository.findById.mockResolvedValueOnce(existing);
    mocks.repository.updateById.mockResolvedValueOnce(existing);

    await productService.deleteProduct({
      tenantId,
      productId: String(existing._id),
    });

    expect(mocks.repository.updateById).toHaveBeenCalledWith(String(existing._id), { $set: { isActive: false, isArchived: true } });
    expect(mocks.deleteUploadedProductImage).not.toHaveBeenCalled();
  });

  it("returns a stable conflict for duplicate product names", async () => {
    mocks.repository.create.mockRejectedValueOnce({ code: 11000 });

    await expect(
      productService.createProduct({
        tenantId,
        createdBy: userId,
        input: {
          name: "Gift voucher",
          description: "",
          sku: "",
          kind: "voucher",
          price: 100,
          extraCharge: 0,
          maxNumberOfParticipants: null,
          imageSrc: "",
          label: "Gift voucher",
          voucherTemplate: "",
          isActive: true,
          sortOrder: 0,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PRODUCT_NAME_CONFLICT",
    });
  });

  it("does not delete immutable system records", async () => {
    mocks.repository.findById.mockResolvedValueOnce(
      productDocument({ type: "system" }),
    );

    await expect(
      productService.deleteProduct({
        tenantId,
        productId: "507f1f77bcf86cd799439013",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SYSTEM_PRODUCT_IMMUTABLE",
    });
    expect(mocks.repository.delete).not.toHaveBeenCalled();
  });

  it("stores the default twelve-month policy on a new voucher offering", async () => {
    mocks.repository.create.mockImplementation((_actor, input) => Promise.resolve(productDocument(input)));
    const result = await productService.createProduct({ tenantId, createdBy: userId, input: { ...classProductInput(), kind: "voucher", label: "Gift", maxNumberOfParticipants: null } });
    expect(result.voucherSettings?.validity).toEqual({ mode: "months", months: 12 });
    expect(mocks.acquireVoucherTenantMutationLock).toHaveBeenCalledWith(tenantId, expect.anything());
    expect(mocks.assertVoucherOfferingPublicationAllowed).toHaveBeenCalledWith(expect.objectContaining({ tenantId, desired: expect.objectContaining({ kind: "voucher" }) }));
  });

  it("does not publish or create a voucher when the quota guard rejects it", async () => {
    mocks.assertVoucherOfferingPublicationAllowed.mockRejectedValue(new Error("limit reached"));
    await expect(productService.createProduct({ tenantId, createdBy: userId, input: { ...classProductInput(), kind: "voucher", label: "Gift", maxNumberOfParticipants: null } })).rejects.toThrow("limit reached");
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("preflights a tenant-owned editor design before creating an offering without a PDF", async () => {
    const design = structuredClone(DEFAULT_VOUCHER_DESIGN);
    const input = { ...classProductInput(), kind: "voucher" as const, label: "Gift", maxNumberOfParticipants: null, voucherTemplate: "", voucherDesign: design };
    mocks.repository.create.mockImplementation(async (_createdBy, saved) => productDocument(saved));
    const result = await productService.createProduct({ tenantId, createdBy: userId, input });
    expect(mocks.prepareVoucherDesign).toHaveBeenCalledWith(tenantId, design);
    expect(result.voucherDesign).toEqual(design);
    expect(result.voucherTemplate).toBe("");
    expect(mocks.repository.create).toHaveBeenCalledWith(userId, expect.objectContaining({ voucherDesign: design }));
  });

  it("does not persist a design when asset or renderer validation fails", async () => {
    mocks.prepareVoucherDesign.mockRejectedValue(new Error("Image belongs to a different workspace"));
    await expect(productService.createProduct({ tenantId, createdBy: userId, input: { ...classProductInput(), kind: "voucher", label: "Gift", maxNumberOfParticipants: null, voucherDesign: structuredClone(DEFAULT_VOUCHER_DESIGN) } })).rejects.toThrow("different workspace");
    expect(mocks.repository.create).not.toHaveBeenCalled();
    expect(mocks.acquireVoucherTenantMutationLock).not.toHaveBeenCalled();
  });

  it("allows an explicit switch back to an existing PDF template", async () => {
    const product = productDocument({ kind: "voucher", type: "coupon", label: "Gift", voucherDesign: structuredClone(DEFAULT_VOUCHER_DESIGN) });
    mocks.repository.findById.mockResolvedValue(product);
    mocks.repository.update.mockImplementation(async (saved) => ({ ...product, ...saved }));
    const result = await productService.updateProduct({ tenantId, input: { id: String(product._id), voucherDesign: null } });
    expect(result.voucherDesign).toBeNull();
    expect(result.voucherTemplate).toBe("private/template.pdf");
  });

  it("rechecks the last artwork under the tenant lock when switching back to a PDF", async () => {
    const initial = productDocument({ kind: "voucher", type: "coupon", label: "Gift", voucherDesign: structuredClone(DEFAULT_VOUCHER_DESIGN) });
    const current = { ...initial, voucherTemplate: "" };
    mocks.repository.findById.mockResolvedValueOnce(initial).mockResolvedValueOnce(current);
    await expect(productService.updateProduct({ tenantId, input: { id: String(initial._id), voucherDesign: null } })).rejects.toMatchObject({ code: "PRODUCT_VOUCHER_TEMPLATE_REQUIRED" });
    expect(mocks.repository.update).not.toHaveBeenCalled();
  });

  it("publishes design-only vouchers without exposing artwork or asset keys in the public catalog", async () => {
    const product = productDocument({
      kind: "voucher",
      type: "coupon",
      voucherTemplate: "",
      voucherDesign: structuredClone(DEFAULT_VOUCHER_DESIGN),
      voucherSettings: {
        version: 1,
        type: "value",
        validity: { mode: "months", months: 12 },
        physicalDelivery: { enabled: true, postageFeeMinor: 9900 },
      },
    });
    mocks.repository.list.mockResolvedValue([product]);
    const result = await productService.listPublicVoucherProducts({ tenantId });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: String(product._id),
      _id: String(product._id),
      name: product.name,
      description: product.description,
      type: "coupon",
      price: product.price,
      currency: product.currency,
      imageSrc: product.imageSrc,
      voucherTemplate: "",
      hasVoucherDesign: true,
      voucherSettings: {
        version: 1,
        type: "value",
        validity: { mode: "months", months: 12 },
        physicalDelivery: { enabled: true, postageFeeMinor: 9900 },
        experienceProductId: null,
      },
      isActive: true,
    });
  });

  it("refuses to publish a voucher with a past custom expiry date", async () => {
    await expect(productService.createProduct({ tenantId, createdBy: userId, input: { ...classProductInput(), kind: "voucher", label: "Gift", maxNumberOfParticipants: null, voucherSettings: { version: 1, type: "value", validity: { mode: "date", date: "2001-01-01" } } } })).rejects.toMatchObject({ code: "VOUCHER_VALIDITY_INVALID" });
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("does not delete or backfill when the deletion policy blocks an offering", async () => {
    const product = productDocument({ kind: "voucher", type: "coupon" });
    mocks.repository.findById.mockResolvedValue(product);
    mocks.assertVoucherOfferingDeletable.mockImplementation(() => { throw new Error("unexpired codes"); });
    await expect(productService.deleteProduct({ tenantId, productId: String(product._id) })).rejects.toThrow("unexpired codes");
    expect(mocks.repository.delete).not.toHaveBeenCalled();
    expect(mocks.preserveLegacyVoucherValuesBeforeDeletion).not.toHaveBeenCalled();
  });


  it("hides elapsed fixed-date and experience offerings from voucher sales until supported", async () => {
    const available = productDocument({ kind: "voucher", type: "coupon", name: "Value gift" });
    const elapsed = productDocument({ kind: "voucher", type: "coupon", voucherSettings: { version: 1, type: "value", validity: { mode: "date", date: "2001-01-01" } } });
    const experience = productDocument({ kind: "voucher", type: "coupon", voucherSettings: { version: 1, type: "experience", validity: { mode: "months", months: 12 }, experienceProductId: "507f1f77bcf86cd799439020", experienceQuantity: 1 } });
    mocks.repository.list.mockResolvedValue([available, elapsed, experience]);
    mocks.repository.count.mockResolvedValue(3);
    const result = await productService.listPublicVoucherProducts({ tenantId });
    expect(result.map((product) => product.id)).toEqual([String(available._id)]);
  });

  it("requires a location when creating canonical or legacy studio products", async () => {
    for (const studioInput of [{ kind: "open-studio", bookingMode: "public" }, { type: "workshop", kind: undefined }, { kind: "private-studio", price: 0, maxNumberOfParticipants: null }]) {
      await expect(productService.createProduct({ tenantId, createdBy: userId, input: { ...classProductInput(), ...studioInput } })).rejects.toMatchObject({ code: "PRODUCT_LOCATION_REQUIRED" });
    }
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("requires a location when converting a global class into a studio product", async () => {
    const existing = productDocument({ kind: "class", type: "course", bookingMode: null });
    mocks.repository.findById.mockResolvedValue(existing);
    await expect(productService.updateProduct({ tenantId, input: { id: String(existing._id), kind: "open-studio", bookingMode: "public" } })).rejects.toMatchObject({ code: "PRODUCT_LOCATION_REQUIRED" });
    expect(mocks.repository.update).not.toHaveBeenCalled();
    mocks.repository.update.mockResolvedValue({ ...existing, kind: "open-studio", type: "workshop", location: new mongoose.Types.ObjectId(locationId) });
    await expect(productService.updateProduct({ tenantId, input: { id: String(existing._id), kind: "open-studio", bookingMode: "public", locationId } })).resolves.toMatchObject({ locationId });
  });

  it("rejects cross-tenant and staff-inaccessible location assignments", async () => {
    const input = { ...classProductInput(), kind: "open-studio", bookingMode: "public", locationId };
    mocks.locationExistsExec.mockResolvedValueOnce([]);
    await expect(productService.createProduct({ tenantId, createdBy: userId, input })).rejects.toMatchObject({ statusCode: 400 });
    await expect(productService.createProduct({ tenantId, createdBy: userId, input, allowedLocationIds: [] })).rejects.toMatchObject({ code: "WORKSPACE_LOCATION_NOT_FOUND" });
    expect(mocks.locationFind).toHaveBeenCalledWith({ tenant: tenantId, _id: { $in: [locationId] } });
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("assigns a legacy studio product once and leaves the product ID unchanged", async () => {
    const existing = productDocument();
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.update.mockResolvedValue({ ...existing, location: new mongoose.Types.ObjectId(locationId) });
    const result = await productService.updateProduct({ tenantId, input: { id: String(existing._id), locationId } });
    expect(result).toMatchObject({ id: String(existing._id), locationId });
    expect(mocks.repository.update).toHaveBeenCalledWith(expect.objectContaining({ id: String(existing._id), locationId }));
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it("rejects moving or changing the kind of an assigned studio product", async () => {
    const existing = productDocument({ location: new mongoose.Types.ObjectId(locationId) });
    mocks.repository.findById.mockResolvedValue(existing);
    for (const patch of [{ locationId: userId }, { locationId: null }, { kind: "class" }]) {
      await expect(productService.updateProduct({ tenantId, input: { id: String(existing._id), ...patch } })).rejects.toMatchObject({ code: "PRODUCT_LOCATION_IMMUTABLE" });
    }
    expect(mocks.repository.update).not.toHaveBeenCalled();
  });

  it("rechecks the location assignment inside the transaction", async () => {
    const existing = productDocument();
    mocks.repository.findById.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, location: new mongoose.Types.ObjectId(userId) });
    await expect(productService.updateProduct({ tenantId, input: { id: String(existing._id), locationId } })).rejects.toMatchObject({ code: "PRODUCT_LOCATION_IMMUTABLE" });
    expect(mocks.repository.update).not.toHaveBeenCalled();
  });

  it("prevents staff from editing or archiving another location's product", async () => {
    const existing = productDocument({ location: new mongoose.Types.ObjectId(locationId) });
    mocks.repository.findById.mockResolvedValue(existing);
    await expect(productService.updateProduct({ tenantId, input: { id: String(existing._id), name: "Changed" }, allowedLocationIds: [userId] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(productService.deleteProduct({ tenantId, productId: String(existing._id), allowedLocationIds: [userId] })).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.repository.update).not.toHaveBeenCalled();
    expect(mocks.repository.delete).not.toHaveBeenCalled();
  });

  it("archives studio products without deleting records used by historical bookings and purchases", async () => {
    const existing = productDocument({ location: new mongoose.Types.ObjectId(locationId) });
    mocks.repository.findById.mockResolvedValue(existing);
    mocks.repository.updateById.mockResolvedValue({ ...existing, isActive: false, isArchived: true });
    const result = await productService.deleteProduct({ tenantId, productId: String(existing._id) });
    expect(result).toMatchObject({ id: String(existing._id), locationId, isActive: false, isArchived: true });
    expect(mocks.repository.updateById).toHaveBeenCalledWith(String(existing._id), { $set: { isActive: false, isArchived: true } });
    expect(mocks.repository.delete).not.toHaveBeenCalled();
  });

  it("rejects a second Open Studio before uploading assets with an actionable existing-product conflict", async () => {
    const existing = productDocument({ location: new mongoose.Types.ObjectId(locationId), isActive: false });
    mocks.repository.findOne.mockResolvedValue(existing);
    await expect(productService.createProduct({ tenantId, createdBy: userId, image: uploadedImage,
      input: { ...classProductInput(), kind: "open-studio", bookingMode: "private", locationId },
    })).rejects.toMatchObject({ statusCode: 409, code: "OPEN_STUDIO_ALREADY_EXISTS", details: { existingProductId: String(existing._id), locationId } });
    expect(mocks.uploadProductImage).not.toHaveBeenCalled();
    expect(mocks.repository.create).not.toHaveBeenCalled();
  });

  it.each([{ tenant: 1, location: 1 }, { tenant: 1, location: 1, name: 1 }])("translates concurrent slot/name index failures into the same actionable Open Studio conflict: %j", async (keyPattern) => {
    const existing = productDocument({ location: new mongoose.Types.ObjectId(locationId) });
    mocks.repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    mocks.repository.create.mockRejectedValueOnce({ code: 11000, keyPattern });
    await expect(productService.createProduct({ tenantId, createdBy: userId,
      input: { ...classProductInput(), kind: "open-studio", bookingMode: "private", locationId },
    })).rejects.toMatchObject({ statusCode: 409, code: "OPEN_STUDIO_ALREADY_EXISTS", details: { existingProductId: String(existing._id), locationId } });
  });

  it("cannot reactivate archived studio products", async () => {
    const archived = productDocument({ isActive: false, isArchived: true });
    mocks.repository.findById.mockResolvedValue(archived);
    await expect(productService.updateProduct({ tenantId, input: { id: String(archived._id), isActive: true } }))
      .rejects.toMatchObject({ code: "PRODUCT_ARCHIVED", statusCode: 409 });
    expect(mocks.repository.update).not.toHaveBeenCalled();
  });

});
