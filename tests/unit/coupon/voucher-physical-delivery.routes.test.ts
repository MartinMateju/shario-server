import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), orderDetail: vi.fn() }));
vi.mock("@/modules/coupon/voucher-physical-delivery.service.js", () => ({
  voucherPhysicalDeliveryService: { dispatch: mocks.dispatch },
}));
vi.mock("@/modules/coupon/voucher-management.service.js", () => ({
  voucherManagementService: { orderDetail: mocks.orderDetail },
}));
vi.mock("@/modules/coupon/voucher-purchase.service.js", () => ({ voucherPurchaseService: {} }));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@/modules/coupon/controllers/coupon.controller.js", () => Object.fromEntries([
  "applyCouponPromoCode", "createManualPromoCode", "getCouponOrdersWithFilters",
  "getCoupons", "getCouponsWithFilters", "getUserRedeemedCoupons", "sendCouponCheckout",
  "updateCouponOrderStatus", "revokeVoucher",
].map((name) => [name, vi.fn()])));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: (req: any) => req.tenantId,
}));
import router from "@/modules/coupon/routes/coupon.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const tenantId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const orderId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const actorId = "cccccccccccccccccccccccc";
const operationId = "fe9bbd00-5ac5-4355-9952-58894a8921b5";
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.tenantId = tenantId;
  if (req.headers["x-auth-context"]) req.userInfo = { id: actorId, authContext: req.headers["x-auth-context"] };
  req.workspaceAccessResolved = true;
  req.workspaceAccess = {
    status: "active",
    permissions: req.headers["x-manage"]
      ? [WORKSPACE_PERMISSION.VOUCHERS_VIEW, WORKSPACE_PERMISSION.VOUCHERS_MANAGE]
      : req.headers["x-view"] ? [WORKSPACE_PERMISSION.VOUCHERS_VIEW] : [],
  };
  next();
});
app.use("/coupons", router);
app.use(((error, _req, res, _next) => res
  .status(error.name === "ZodError" ? 400 : error.statusCode || 500)
  .json({ code: error.code })) satisfies ErrorRequestHandler);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue({ _id: orderId });
  mocks.orderDetail.mockResolvedValue({
    order: { id: orderId }, physicalDelivery: { status: "dispatched", canDispatch: false },
  });
});

describe("private voucher dispatch action", () => {
  it("rejects anonymous, customer and view-only staff requests", async () => {
    await request(app).post(`/coupons/orders/${orderId}/dispatch`).send({ operationId }).expect(401);
    await request(app).post(`/coupons/orders/${orderId}/dispatch`)
      .set("x-auth-context", "customer").set("x-manage", "true").send({ operationId }).expect(403);
    await request(app).post(`/coupons/orders/${orderId}/dispatch`)
      .set("x-auth-context", "workspace").set("x-view", "true").send({ operationId }).expect(403);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("uses authenticated tenant and actor, returns private details and rejects body ownership overrides", async () => {
    const response = await request(app).post(`/coupons/orders/${orderId}/dispatch`)
      .set("x-auth-context", "workspace").set("x-manage", "true").send({ operationId }).expect(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.physicalDelivery.status).toBe("dispatched");
    expect(mocks.dispatch).toHaveBeenCalledWith({ tenantId, actorId, couponOrderId: orderId, operationId });
    expect(mocks.orderDetail).toHaveBeenCalledWith(tenantId, orderId);
    for (const body of [{}, { operationId: "invalid" }, { operationId, tenantId: actorId }, { operationId, dispatchedAt: "2020-01-01" }]) {
      await request(app).post(`/coupons/orders/${orderId}/dispatch`)
        .set("x-auth-context", "workspace").set("x-manage", "true").send(body).expect(400);
    }
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});
