import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_BOOKING_PRODUCT_TYPE,
  PRODUCT_TYPE,
} from "@/modules/product/product.constants.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findOne: vi.fn(),
  getTenantOrThrow: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  uploadBufferToR2: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));

vi.mock("@/modules/product/product.repository.js", () => ({
  createProductRepository: vi.fn(() => ({
    count: mocks.count,
    findOne: mocks.findOne,
    list: mocks.list,
  })),
}));

import {
  isPublicProductTypeEnabled,
  productService,
} from "@/modules/product/services/product.service.js";

const enabledModules = {
  [TENANT_MODULE.PAYMENTS]: true,
  [TENANT_MODULE.BOOKINGS]: true,
  [TENANT_MODULE.COURSES]: true,
  [TENANT_MODULE.MEMBERSHIPS]: true,
  [TENANT_MODULE.CREDITS]: true,
  [TENANT_MODULE.VOUCHERS]: true,
  [TENANT_MODULE.FIRING]: true,
};

describe("public product effective-module gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantOrThrow.mockResolvedValue({
      modules: enabledModules,
    });
    mocks.list.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
  });

  it.each([
    [PRODUCT_TYPE.COURSE, TENANT_MODULE.COURSES],
    [LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE, TENANT_MODULE.COURSES],
    [PRODUCT_TYPE.WORKSHOP, TENANT_MODULE.BOOKINGS],
    [LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP, TENANT_MODULE.BOOKINGS],
    [LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_WORKSHOP, TENANT_MODULE.BOOKINGS],
    [PRODUCT_TYPE.GIFT_CARD, TENANT_MODULE.VOUCHERS],
    [PRODUCT_TYPE.COUPON, TENANT_MODULE.VOUCHERS],
  ])("maps %s to its owning workspace module", (type, moduleName) => {
    expect(
      isPublicProductTypeEnabled({
        modules: {
          [TENANT_MODULE.PAYMENTS]: true,
          [moduleName]: true,
        },
        type,
      }),
    ).toBe(true);
    expect(
      isPublicProductTypeEnabled({
        modules: {
          [TENANT_MODULE.PAYMENTS]: true,
          [moduleName]: false,
        },
        type,
      }),
    ).toBe(false);
  });

  it("requires payments and rejects removed retail products", () => {
    expect(
      isPublicProductTypeEnabled({
        modules: { [TENANT_MODULE.PAYMENTS]: false },
        type: PRODUCT_TYPE.PHYSICAL_PRODUCT,
      }),
    ).toBe(false);
    expect(
      isPublicProductTypeEnabled({
        modules: { [TENANT_MODULE.PAYMENTS]: true },
        type: PRODUCT_TYPE.PHYSICAL_PRODUCT,
      }),
    ).toBe(false);
  });

  it("keeps ambiguous legacy services out of the public catalog", () => {
    expect(
      isPublicProductTypeEnabled({
        modules: {
          [TENANT_MODULE.PAYMENTS]: true,
          [TENANT_MODULE.FIRING]: true,
        },
        type: PRODUCT_TYPE.SERVICE,
      }),
    ).toBe(false);
    expect(
      isPublicProductTypeEnabled({
        modules: {
          [TENANT_MODULE.PAYMENTS]: true,
          [TENANT_MODULE.FIRING]: true,
        },
        type: PRODUCT_TYPE.WORKSHOP,
      }),
    ).toBe(false);
  });

  it("filters the generic catalog before pagination and counting", async () => {
    mocks.getTenantOrThrow.mockResolvedValueOnce({
      modules: {
        [TENANT_MODULE.PAYMENTS]: true,
        [TENANT_MODULE.COURSES]: true,
        [TENANT_MODULE.CREDITS]: true,
        [TENANT_MODULE.FIRING]: true,
      },
    });

    await expect(
      productService.listPublicProducts({
        tenantId: "507f1f77bcf86cd799439011",
      }),
    ).resolves.toMatchObject({
      products: [],
      totalCount: 0,
    });

    const expectedTypes = [
      PRODUCT_TYPE.COURSE,
      LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE,
    ];

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ types: expectedTypes }),
    );
    expect(mocks.count).toHaveBeenCalledWith(
      expect.objectContaining({ types: expectedTypes }),
    );
  });

  it("returns an empty catalog without querying products when payments are disabled", async () => {
    mocks.getTenantOrThrow.mockResolvedValueOnce({
      modules: { [TENANT_MODULE.PAYMENTS]: false },
    });

    await expect(
      productService.listPublicProducts({
        tenantId: "507f1f77bcf86cd799439011",
        page: 3,
        limit: 12,
      }),
    ).resolves.toEqual({
      products: [],
      totalCount: 0,
      currentPage: 3,
      pageSize: 12,
      totalPages: 0,
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it.each([
    { pages: { courses: { visible: false } } },
    { customerPortal: { pages: { courses: { enabled: false } } } },
  ])(
    "filters hidden courses before generic catalog pagination and rejects their direct details: %o",
    async (published) => {
      mocks.getTenantOrThrow.mockResolvedValue({
        modules: enabledModules,
        publicSiteEditor: { published, draft: {} },
      });
      await productService.listPublicProducts({
        tenantId: "507f1f77bcf86cd799439011",
        respectPublicCourseVisibility: true,
      });
      const types = mocks.list.mock.calls[0][0].types;
      expect(types).not.toContain(PRODUCT_TYPE.COURSE);
      expect(types).not.toContain(LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE);
      expect(types).toContain(PRODUCT_TYPE.COUPON);
      expect(mocks.count.mock.calls[0][0].types).toEqual(types);

      mocks.findOne.mockResolvedValue({ type: PRODUCT_TYPE.COURSE });
      await expect(
        productService.getPublicProduct({
          tenantId: "507f1f77bcf86cd799439011",
          productId: "507f1f77bcf86cd799439012",
          respectPublicCourseVisibility: true,
        }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "PUBLIC_PRODUCT_NOT_FOUND",
      });
    },
  );

  it("keeps unpublished draft previews and existing authenticated catalog access independent of anonymous visibility", async () => {
    mocks.getTenantOrThrow.mockResolvedValue({
      modules: enabledModules,
      publicSiteEditor: {
        published: {
          customerPortal: { pages: { courses: { enabled: false } } },
        },
        draft: {},
      },
    });
    await productService.listPublicProducts({
      tenantId: "507f1f77bcf86cd799439011",
      coursesOnly: true,
    });
    expect(mocks.list.mock.calls[0][0].types).toEqual([
      PRODUCT_TYPE.COURSE,
      LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE,
    ]);
  });

  it("rejects a public detail whose owning module is disabled", async () => {
    mocks.getTenantOrThrow.mockResolvedValueOnce({
      modules: {
        [TENANT_MODULE.PAYMENTS]: true,
        [TENANT_MODULE.COURSES]: false,
      },
    });
    mocks.findOne.mockResolvedValueOnce({
      type: PRODUCT_TYPE.COURSE,
    });

    await expect(
      productService.getPublicProduct({
        tenantId: "507f1f77bcf86cd799439011",
        productId: "507f1f77bcf86cd799439012",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_MODULE_REQUIRED",
      details: { requiredModule: TENANT_MODULE.COURSES },
    });
  });

  it("puts the payments gate before the courses gate on the public course catalog", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../src/modules/product/routes/product.public.routes.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const courseRoute = source.slice(
      source.indexOf('"/tenants/:tenantSlug/products/courses"'),
      source.indexOf('"/tenants/:tenantSlug/products/:productId/sessions"'),
    );

    expect(courseRoute.indexOf("TENANT_MODULE.PAYMENTS")).toBeGreaterThan(-1);
    expect(courseRoute.indexOf("TENANT_MODULE.COURSES")).toBeGreaterThan(
      courseRoute.indexOf("TENANT_MODULE.PAYMENTS"),
    );
  });
});
