import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPublishedTenantBySlug: vi.fn(),
  getTenantSubscriptionAccess: vi.fn(),
  listPublicVoucherProducts: vi.fn(),
  listCouponProducts: vi.fn(),
  pass: vi.fn((_req, _res, next) => next()),
}));

vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicCommerceMutationLimiter: mocks.pass,
  publicTenantLookupLimiter: mocks.pass,
}));
vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  findPublishedTenantBySlug: mocks.findPublishedTenantBySlug,
}));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: vi.fn(),
}));
vi.mock("@/modules/product/services/product.service.js", () => ({
  productService: {
    listPublicVoucherProducts: mocks.listPublicVoucherProducts,
  },
}));
vi.mock("@/modules/coupon/coupon.service.js", () => ({
  couponService: { listCouponProducts: mocks.listCouponProducts },
}));
vi.mock("@/modules/coupon/voucher-lifecycle.service.js", () => ({
  voucherLifecycleService: {},
}));
vi.mock("@/modules/coupon/controllers/voucher-purchase.controller.js", () => ({
  downloadVoucherPurchase: mocks.pass,
  getVoucherPurchaseStatus: mocks.pass,
  resendVoucherPurchase: mocks.pass,
  voucherPurchaseResponseHeaders: mocks.pass,
}));
vi.mock("@/modules/checkout/controllers/checkout.controller.js", () => ({
  getGuestCheckoutOrderStatus: mocks.pass,
}));

import { publicTenantCommerceRouter } from "@/modules/checkout/checkout.public.routes.js";

const tenant = {
  _id: "507f1f77bcf86cd799439011",
  slug: "klei",
  modules: { vouchers: true, payments: true },
};
const catalogVoucher = {
  id: "507f1f77bcf86cd799439012",
  _id: "507f1f77bcf86cd799439012",
  name: "Studio gift",
  description: "A gift for making pottery",
  type: "coupon",
  price: 1000,
  currency: "CZK",
  imageSrc: "",
  voucherTemplate: "",
  hasVoucherDesign: true,
  voucherSettings: {
    version: 1,
    type: "value",
    validity: { mode: "months", months: 12 },
    physicalDelivery: { enabled: true, postageFeeMinor: 9900 },
  },
  isActive: true,
};
const app = express();
app.use("/public", publicTenantCommerceRouter);
app.use(((error, _req, res, _next) =>
  res
    .status(error.statusCode || 500)
    .json({ code: error.code })) satisfies ErrorRequestHandler);

describe("public voucher catalog response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findPublishedTenantBySlug.mockResolvedValue(tenant);
    mocks.getTenantSubscriptionAccess.mockResolvedValue({
      access: { canUseFeatures: true },
    });
    mocks.listPublicVoucherProducts.mockResolvedValue([catalogVoucher]);
    mocks.listCouponProducts.mockResolvedValue([
      {
        ...catalogVoucher,
        hasVoucherDesign: undefined,
        tenant: tenant._id,
        sku: "INTERNAL-SKU",
        voucherDesign: { privateAssetKey: "private/artwork.png" },
      },
    ]);
  });

  it("serves the safe designer-aware catalog with its physical delivery offer", async () => {
    const response = await request(app)
      .get("/public/tenants/klei/vouchers/products")
      .query({ tenantId: "507f1f77bcf86cd799439099", isActive: false })
      .expect(200);

    expect(mocks.findPublishedTenantBySlug).toHaveBeenCalledWith("klei");
    expect(mocks.listPublicVoucherProducts).toHaveBeenCalledWith({
      tenantId: tenant._id,
      limit: 100,
    });
    expect(mocks.listCouponProducts).not.toHaveBeenCalled();
    expect(response.body).toEqual([catalogVoucher]);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    for (const field of ["voucherDesign", "tenant", "createdBy", "sku"]) {
      expect(response.body[0]).not.toHaveProperty(field);
    }
  });

  it("does not expose vouchers from an unpublished studio", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(null);
    await request(app)
      .get("/public/tenants/klei/vouchers/products")
      .expect(404);
    expect(mocks.listPublicVoucherProducts).not.toHaveBeenCalled();
  });

  it("preserves the subscription and voucher module gates", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({
      access: { canUseFeatures: false },
    });
    await request(app)
      .get("/public/tenants/klei/vouchers/products")
      .expect(403);
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce({
      ...tenant,
      modules: { ...tenant.modules, vouchers: false },
    });
    await request(app)
      .get("/public/tenants/klei/vouchers/products")
      .expect(403);
    expect(mocks.listPublicVoucherProducts).not.toHaveBeenCalled();
  });
});
