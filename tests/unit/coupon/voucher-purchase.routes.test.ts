import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  download: vi.fn(),
  resend: vi.fn(),
  tenant: vi.fn(),
  publication: vi.fn(),
  subscription: vi.fn(),
}));
vi.mock("@/modules/coupon/voucher-purchase.service.js", () => ({
  voucherPurchaseService: mocks,
}));
vi.mock("@/modules/coupon/controllers/coupon.controller.js", () => ({
  getCoupons: vi.fn(),
  sendCouponCheckout: vi.fn(),
}));
vi.mock("@/modules/checkout/controllers/checkout.controller.js", () => ({
  getGuestCheckoutOrderStatus: vi.fn(),
}));
vi.mock("@/modules/setup-center/setup-publication.middleware.js", () => ({
  loadPublishedTenant: mocks.publication,
}));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({ getTenantSubscriptionAccess: mocks.subscription }),
);
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.tenant,
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: (req: any) => req.tenantId,
}));
vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicCommerceMutationLimiter: (_req: any, _res: any, next: () => void) =>
    next(),
  publicTenantLookupLimiter: (_req: any, _res: any, next: () => void) => next(),
}));

import { publicTenantCommerceRouter } from "@/modules/checkout/checkout.public.routes.js";
const tenantId = "507f1f77bcf86cd799439011";
const couponOrderId = "507f1f77bcf86cd799439012";
const accessToken = "a".repeat(43);
const base = `/public/tenants/klei/vouchers/orders/${couponOrderId}`;
const app = express();
app.use(express.json());
app.use("/public", publicTenantCommerceRouter);
app.use(((error, _req, res, _next) =>
  res
    .status(error.statusCode || 500)
    .json({ code: error.code })) satisfies ErrorRequestHandler);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockResolvedValue({
    _id: tenantId,
    slug: "klei",
    modules: { vouchers: false, payments: false },
  });
  mocks.publication.mockImplementation((_req: any, res: any) =>
    res.sendStatus(403),
  );
  mocks.subscription.mockResolvedValue({ access: { canUseFeatures: false } });
  mocks.status.mockResolvedValue({
    status: "ready",
    documents: [{ index: 0, filename: "Voucher_1.pdf" }],
  });
  mocks.download.mockResolvedValue({
    filename: "Voucher_1.pdf",
    content: Buffer.from("%PDF purchased voucher"),
    contentType: "application/pdf",
  });
  mocks.resend.mockResolvedValue({
    status: "ready",
    deliveryStatus: "pending",
    canResend: false,
  });
});

describe("historical guest voucher purchase routes", () => {
  it("keeps bearer-proven paid purchases accessible after unpublishing and disabling sales", async () => {
    const response = await request(app)
      .post(`${base}/status`)
      .send({ accessToken })
      .expect(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(mocks.tenant).toHaveBeenCalledWith("klei");
    expect(mocks.status).toHaveBeenCalledWith({
      tenantId,
      couponOrderId,
      accessToken,
    });
    expect(mocks.publication).not.toHaveBeenCalled();
    expect(mocks.subscription).not.toHaveBeenCalled();
  });

  it.each(["status", "download", "resend"])(
    "does not accept order IDs or query-string secrets as proof for %s",
    async (path) => {
      await request(app)
        .post(`${base}/${path}?accessToken=${accessToken}`)
        .send(path === "download" ? { index: 0 } : {})
        .expect(404);
      expect(mocks[path]).not.toHaveBeenCalled();
    },
  );

  it("rejects arbitrary recipients, codes, tenant overrides and document paths", async () => {
    for (const extra of [
      { email: "someone-else@example.com" },
      { tenantId: "other" },
      { promoCode: "FAKE" },
    ]) {
      await request(app)
        .post(`${base}/resend`)
        .send({ accessToken, ...extra })
        .expect(400);
    }
    await request(app)
      .post(`${base}/download`)
      .send({ accessToken, index: 0, key: "another-tenant/private.pdf" })
      .expect(400);
    await request(app)
      .post(`${base}/download`)
      .send({ accessToken, index: -1 })
      .expect(400);
    expect(mocks.resend).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("serves the authenticated PDF as a noncacheable attachment", async () => {
    const response = await request(app)
      .post(`${base}/download`)
      .send({ accessToken, index: 0 })
      .expect(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="Voucher_1.pdf"',
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.download).toHaveBeenCalledWith({
      tenantId,
      couponOrderId,
      accessToken,
      index: 0,
    });
  });

  it("acknowledges an explicit resend only through the proven purchase", async () => {
    await request(app)
      .post(`${base}/resend`)
      .send({ accessToken })
      .expect(202, {
        status: "ready",
        deliveryStatus: "pending",
        canResend: false,
      });
    expect(mocks.resend).toHaveBeenCalledWith({
      tenantId,
      couponOrderId,
      accessToken,
    });
  });

  it("does not resolve an order when the historical tenant no longer exists", async () => {
    mocks.tenant.mockResolvedValue(null);
    await request(app).post(`${base}/status`).send({ accessToken }).expect(404);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
