import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const verifyJWT = vi.fn((_req, _res, next) => next());
  const requirePermission = vi.fn((permission: string) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermission: permission });
    return middleware;
  });
  const requireTenantModule = vi.fn((moduleName: string) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { tenantModule: moduleName });
    return middleware;
  });

  return {
    handler: vi.fn(),
    requirePermission,
    requireTenantModule,
    uploadProductFiles: vi.fn((_req, _res, next) => next()),
    uploadSingleProductFile: vi.fn((_req, _res, next) => next()),
    verifyJWT,
  };
});

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: mocks.verifyJWT,
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/modules/tenants/middleware/requireTenantModule.js", () => ({
  requireTenantModule: mocks.requireTenantModule,
}));

vi.mock("@/modules/product/middleware/productUpload.middleware.js", () => ({
  uploadProductFiles: mocks.uploadProductFiles,
  uploadSingleProductFile: mocks.uploadSingleProductFile,
}));

vi.mock("@/modules/product/controllers/product.controller.js", () => ({
  createProduct: mocks.handler,
  deleteProduct: mocks.handler,
  getCustomerCourseCatalog: vi.fn((_req, res) => res.status(200).json({products: []})),
  getPublicCourseSessions: vi.fn((_req, res) => res.status(200).json({sessions: []})),
  getCustomerCatalog: mocks.handler,
  getCourseProducts: mocks.handler,
  getProducts: mocks.handler,
  getVoucherAllowance: mocks.handler,
  getProductDeletionPolicy: mocks.handler,
  updateProduct: mocks.handler,
  uploadCouponTemplate: mocks.handler,
}));

vi.mock(
  "@/modules/product/controllers/product-class-category.controller.js",
  () => ({
    createProductClassCategory: mocks.handler,
    deleteProductClassCategory: mocks.handler,
    listProductClassCategories: mocks.handler,
  }),
);

import productRouter from "@/modules/product/routes/product.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

type TaggedHandle = {
  workspacePermission?: string;
  tenantModule?: string;
};

type RouterLayer = {
  handle: TaggedHandle;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: TaggedHandle;
    }>;
  };
};

const stack = productRouter.stack as unknown as RouterLayer[];

const routeTags = (path: string, method: string) => {
  const layer = stack.find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method] === true,
  );

  expect(
    layer,
    `${method.toUpperCase()} ${path} must be registered`,
  ).toBeDefined();

  return {
    permissions:
      layer?.route?.stack
        .map(({ handle }) => handle.workspacePermission)
        .filter((value): value is string => Boolean(value)) ?? [],
    modules:
      layer?.route?.stack
        .map(({ handle }) => handle.tenantModule)
        .filter((value): value is string => Boolean(value)) ?? [],
  };
};

const routeHandles = (path: string, method: string): TaggedHandle[] =>
  stack
    .find(
      (candidate) =>
        candidate.route?.path === path &&
        candidate.route.methods[method] === true,
    )
    ?.route?.stack.map(({ handle }) => handle) ?? [];

describe("product route authorization", () => {
  it("limits voucher allowance and deletion previews to workspace product permissions", () => {
    expect(routeTags("/voucher-allowance", "get").permissions).toEqual([WORKSPACE_PERMISSION.PRODUCTS_VIEW]);
    expect(routeTags("/:productId/deletion-policy", "get").permissions).toEqual([WORKSPACE_PERMISSION.PRODUCTS_MANAGE]);
  });
  it("authenticates before registering product routes", () => {
    expect(stack[0]?.handle).toBe(mocks.verifyJWT);
  });

  it("uses read permissions for catalog and course reads", () => {
    expect(routeTags("/", "get")).toEqual({
      permissions: [WORKSPACE_PERMISSION.PRODUCTS_VIEW],
      modules: [],
    });
    expect(routeTags("/courses", "get")).toEqual({
      permissions: [WORKSPACE_PERMISSION.COURSES_VIEW],
      modules: ["courses"],
    });
    expect(routeTags("/class-categories", "get")).toEqual({
      permissions: [WORKSPACE_PERMISSION.PRODUCTS_VIEW],
      modules: ["courses"],
    });
  });

  it("exposes the customer catalog behind payments without a workspace permission", () => {
    expect(routeTags("/customer-catalog", "get")).toEqual({
      permissions: [],
      modules: ["payments"],
    });
  });

  it.each([
    ["/", "post"],
    ["/class-categories", "post"],
    ["/class-categories/:categoryId", "delete"],
    ["/coupon-template", "post"],
    ["/", "patch"],
    ["/", "delete"],
  ] as const)("reserves %s %s for product managers", (path, method) => {
    expect(routeTags(path, method)).toEqual({
      permissions: [WORKSPACE_PERMISSION.PRODUCTS_MANAGE],
      modules: path.startsWith("/class-categories") ? ["courses"] : [],
    });
  });

  it("uses the mixed product upload only for create/update and keeps the PDF-only endpoint", () => {
    expect(routeHandles("/", "post")).toContain(mocks.uploadProductFiles);
    expect(routeHandles("/", "patch")).toContain(mocks.uploadProductFiles);
    expect(routeHandles("/coupon-template", "post")).toContain(
      mocks.uploadSingleProductFile,
    );
    expect(routeHandles("/coupon-template", "post")).not.toContain(
      mocks.uploadProductFiles,
    );
  });

  it("mounts the public catalog before the protected feature boundary", () => {
    const source = readFileSync(
      new URL("../../../src/app/routes.ts", import.meta.url),
      "utf8",
    );
    const publicCatalogMount = source.indexOf(
      'apiRouter.use("/public", publicProductRouter);',
    );
    const protectedBoundary = source.indexOf(
      "apiRouter.use(verifyJWT, requireTenantSubscriptionAccess);",
    );

    expect(publicCatalogMount).toBeGreaterThan(-1);
    expect(protectedBoundary).toBeGreaterThan(-1);
    expect(publicCatalogMount).toBeLessThan(protectedBoundary);
  });

  it("keeps the customer catalog behind the authenticated subscription boundary", () => {
    const source = readFileSync(
      new URL("../../../src/app/routes.ts", import.meta.url),
      "utf8",
    );
    const protectedBoundary = source.indexOf(
      "apiRouter.use(verifyJWT, requireTenantSubscriptionAccess);",
    );
    const productRouterMount = source.indexOf(
      'apiRouter.use("/products", productRoutes);',
    );

    expect(protectedBoundary).toBeGreaterThan(-1);
    expect(productRouterMount).toBeGreaterThan(protectedBoundary);
  });
});
