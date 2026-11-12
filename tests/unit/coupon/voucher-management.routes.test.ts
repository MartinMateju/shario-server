import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  orderDetail: vi.fn(),
  download: vi.fn(),
  resend: vi.fn(),
  refund: vi.fn(),
}));
vi.mock("@/modules/coupon/voucher-management.service.js", () => ({
  voucherManagementService: mocks,
}));
vi.mock("@/modules/coupon/voucher-purchase.service.js", () => ({
  voucherPurchaseService: {},
}));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@/modules/coupon/controllers/coupon.controller.js", () =>
  Object.fromEntries(
    [
      "applyCouponPromoCode",
      "createManualPromoCode",
      "getCouponOrdersWithFilters",
      "getCoupons",
      "getCouponsWithFilters",
      "getUserRedeemedCoupons",
      "sendCouponCheckout",
      "updateCouponOrderStatus",
      "revokeVoucher",
    ].map((name) => [name, vi.fn()]),
  ),
);
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: (req: any) => req.tenantId,
}));
import router from "@/modules/coupon/routes/coupon.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const tenantId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const orderId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const actorId = "cccccccccccccccccccccccc";
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.tenantId = tenantId;
  if (req.headers["x-auth-context"])
    req.userInfo = { id: actorId, authContext: req.headers["x-auth-context"] };
  req.workspaceAccessResolved = true;
  req.workspaceAccess = {
    status: "active",
    permissions: req.headers["x-manage"]
      ? [
          WORKSPACE_PERMISSION.VOUCHERS_VIEW,
          WORKSPACE_PERMISSION.VOUCHERS_MANAGE,
        ]
      : req.headers["x-view"]
        ? [WORKSPACE_PERMISSION.VOUCHERS_VIEW]
        : [],
  };
  next();
});
app.use("/coupons", router);
app.use(((error, _req, res, _next) =>
  res
    .status(error.name === "ZodError" ? 400 : error.statusCode || 500)
    .json({ code: error.code })) satisfies ErrorRequestHandler);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.detail.mockResolvedValue({ voucher: { id: orderId }, ledger: [] });
  mocks.orderDetail.mockResolvedValue({ order: { id: orderId } });
  mocks.download.mockResolvedValue({
    filename: "Voucher.pdf",
    content: Buffer.from("%PDF original"),
  });
  mocks.resend.mockResolvedValue({ canResend: false });
  mocks.refund.mockResolvedValue({
    refund: { request: { status: "pending" } },
  });
});

describe("authenticated voucher management routes", () => {
  it("denies anonymous and customer-session access to workspace voucher records", async () => {
    await request(app).get(`/coupons/orders/${orderId}`).expect(401);
    await request(app)
      .get(`/coupons/orders/${orderId}`)
      .set("x-auth-context", "customer")
      .set("x-manage", "true")
      .expect(403);
    expect(mocks.orderDetail).not.toHaveBeenCalled();
  });
  it("requires voucher view permission even for a valid workspace session", async () => {
    await request(app)
      .get(`/coupons/promo-codes/${orderId}`)
      .set("x-auth-context", "workspace")
      .expect(403);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it("lets a voucher viewer inspect history and download the original private PDF", async () => {
    await request(app)
      .get(`/coupons/promo-codes/${orderId}`)
      .set("x-auth-context", "workspace")
      .set("x-view", "true")
      .expect(200);
    const response = await request(app)
      .post(`/coupons/orders/${orderId}/download`)
      .set("x-auth-context", "workspace")
      .set("x-view", "true")
      .send({ index: 0 })
      .expect(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(mocks.download).toHaveBeenCalledWith(tenantId, orderId, 0);
  });
  it.each(["resend", "refund"])(
    "denies %s to a view-only staff member",
    async (action) => {
      await request(app)
        .post(`/coupons/orders/${orderId}/${action}`)
        .set("x-auth-context", "workspace")
        .set("x-view", "true")
        .send({})
        .expect(403);
      expect(mocks[action]).not.toHaveBeenCalled();
    },
  );
  it("passes the authenticated tenant and actor into a refund, never body-supplied ownership", async () => {
    const body = {
      operationId: "fe9bbd00-5ac5-4355-9952-58894a8921b5",
      reason: "Customer request",
    };
    await request(app)
      .post(`/coupons/orders/${orderId}/refund`)
      .set("x-auth-context", "workspace")
      .set("x-manage", "true")
      .send(body)
      .expect(202);
    expect(mocks.refund).toHaveBeenCalledWith({
      ...body,
      tenantId,
      actorId,
      couponOrderId: orderId,
    });
    await request(app)
      .post(`/coupons/orders/${orderId}/refund`)
      .set("x-auth-context", "workspace")
      .set("x-manage", "true")
      .send({ ...body, tenantId: actorId, amountMinor: 1 })
      .expect(400);
    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });
  it("rejects replacement email recipients and arbitrary PDF indices", async () => {
    await request(app)
      .post(`/coupons/orders/${orderId}/resend`)
      .set("x-auth-context", "workspace")
      .set("x-manage", "true")
      .send({ email: "other@example.test" })
      .expect(400);
    await request(app)
      .post(`/coupons/orders/${orderId}/download`)
      .set("x-auth-context", "workspace")
      .set("x-view", "true")
      .send({ index: -1 })
      .expect(400);
    expect(mocks.resend).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
