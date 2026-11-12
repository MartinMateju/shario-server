import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCoupons: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@/modules/coupon/coupon.service.js", () => ({
  couponService: { listCoupons: mocks.listCoupons },
}));
vi.mock("@/modules/coupon/voucher-archive.service.js", () => ({
  voucherArchiveService: {
    archive: mocks.archive,
    restore: mocks.restore,
  },
}));
vi.mock("@/modules/coupon/voucher-lifecycle.service.js", () => ({
  voucherLifecycleService: {},
}));
vi.mock("@/modules/coupon/voucher-management.service.js", () => ({
  voucherManagementService: {},
}));
vi.mock("@/modules/coupon/voucher-purchase.service.js", () => ({
  voucherPurchaseService: {},
}));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: (req: any) => req.tenantId,
}));

import router from "@/modules/coupon/routes/coupon.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const tenantId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const couponId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const actorId = "cccccccccccccccccccccccc";
const productId = "dddddddddddddddddddddddd";
const otherTenantId = "eeeeeeeeeeeeeeeeeeeeeeee";
const operationId = "fe9bbd00-5ac5-4355-9952-58894a8921b5";
const voucher = { id: couponId, productId, archiveState: "archived" };
const listResult = {
  coupons: [voucher],
  totalCount: 1,
  totalPages: 1,
  currentPage: 1,
  pageSize: 8,
};

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.tenantId = tenantId;
  if (req.headers["x-auth-context"]) {
    req.userInfo = {
      id: actorId,
      authContext: req.headers["x-auth-context"],
    };
  }
  req.workspaceAccessResolved = true;
  req.workspaceAccess = {
    status: "active",
    permissions: req.headers["x-manage"]
      ? [WORKSPACE_PERMISSION.VOUCHERS_MANAGE]
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
  mocks.listCoupons.mockResolvedValue(listResult);
  mocks.archive.mockResolvedValue(voucher);
  mocks.restore.mockResolvedValue({ ...voucher, archiveState: "unarchived" });
});

describe("workspace voucher code filters", () => {
  it("defaults to unarchived codes and all lifecycle statuses", async () => {
    const response = await request(app)
      .post("/coupons/promo-codes/filter")
      .set("x-auth-context", "workspace")
      .set("x-view", "true")
      .send({})
      .expect(200);

    expect(mocks.listCoupons).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        archiveState: "unarchived",
        status: "all",
      }),
    );
    expect(mocks.listCoupons.mock.calls[0][0]).not.toHaveProperty("productId");
    expect(response.body).toEqual(listResult);
  });

  it.each(["unarchived", "archived", "all"])(
    "passes the exact product and %s archive filter within the authenticated tenant",
    async (archiveState) => {
      await request(app)
        .post("/coupons/promo-codes/filter")
        .set("x-auth-context", "workspace")
        .set("x-view", "true")
        .send({
          productId,
          archiveState,
          status: "all",
          tenantId: otherTenantId,
          tenant: otherTenantId,
        })
        .expect(200);

      expect(mocks.listCoupons).toHaveBeenCalledWith(
        expect.objectContaining({
          productId,
          archiveState,
          status: "all",
          tenantId,
        }),
      );
      expect(mocks.listCoupons.mock.calls[0][0]).not.toHaveProperty("tenant");
    },
  );

  it.each([
    "all",
    "active",
    "partially_redeemed",
    "reserved",
    "redeemed",
    "expired",
    "revoked",
    "review_required",
    "inactive",
  ])("accepts the %s lifecycle filter", async (status) => {
    await request(app)
      .post("/coupons/promo-codes/filter")
      .set("x-auth-context", "workspace")
      .set("x-view", "true")
      .send({ status, isActive: "all" })
      .expect(200);

    expect(mocks.listCoupons).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, status, isActive: "all" }),
    );
  });

  it.each([
    ["invalid product ID", { productId: "course-name" }],
    ["product query operator", { productId: { $ne: productId } }],
    ["unsupported archive state", { archiveState: "deleted" }],
    ["unsupported lifecycle status", { status: "unused" }],
  ])("rejects an %s before listing records", async (_label, body) => {
    await request(app)
      .post("/coupons/promo-codes/filter")
      .set("x-auth-context", "workspace")
      .set("x-view", "true")
      .send(body)
      .expect(400);

    expect(mocks.listCoupons).not.toHaveBeenCalled();
  });

  it("requires a workspace session and voucher view permission", async () => {
    await request(app)
      .post("/coupons/promo-codes/filter")
      .send({})
      .expect(401);
    await request(app)
      .post("/coupons/promo-codes/filter")
      .set("x-auth-context", "customer")
      .set("x-view", "true")
      .send({})
      .expect(403);
    await request(app)
      .post("/coupons/promo-codes/filter")
      .set("x-auth-context", "workspace")
      .send({})
      .expect(403);

    expect(mocks.listCoupons).not.toHaveBeenCalled();
  });
});

describe.each(["archive", "restore"] as const)(
  "workspace voucher %s route",
  (action) => {
    const route = `/coupons/promo-codes/${couponId}/${action}`;

    it("denies anonymous, customer, and view-only requests", async () => {
      await request(app).patch(route).send({ operationId }).expect(401);
      await request(app)
        .patch(route)
        .set("x-auth-context", "customer")
        .set("x-manage", "true")
        .send({ operationId })
        .expect(403);
      await request(app)
        .patch(route)
        .set("x-auth-context", "workspace")
        .set("x-view", "true")
        .send({ operationId })
        .expect(403);

      expect(mocks.archive).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
    });

    it("allows voucher managers and uses authenticated ownership and the route ID", async () => {
      const reason = "Reorganize issued course codes";
      const response = await request(app)
        .patch(route)
        .set("x-auth-context", "workspace")
        .set("x-manage", "true")
        .send({ operationId, reason })
        .expect(200);

      expect(mocks[action]).toHaveBeenCalledExactlyOnceWith({
        tenantId,
        couponId,
        actorId,
        operationId,
        reason,
      });
      expect(response.body).toEqual({
        voucher: {
          ...voucher,
          archiveState: action === "archive" ? "archived" : "unarchived",
        },
      });
      expect(mocks[action === "archive" ? "restore" : "archive"]).not.toHaveBeenCalled();
    });

    it("accepts an omitted reason and a reason at the 1000-character limit", async () => {
      await request(app)
        .patch(route)
        .set("x-auth-context", "workspace")
        .set("x-manage", "true")
        .send({ operationId })
        .expect(200);
      expect(mocks[action]).toHaveBeenLastCalledWith(
        expect.objectContaining({ tenantId, couponId, actorId, operationId }),
      );

      const reason = "a".repeat(1000);
      await request(app)
        .patch(route)
        .set("x-auth-context", "workspace")
        .set("x-manage", "true")
        .send({ operationId, reason })
        .expect(200);
      expect(mocks[action]).toHaveBeenLastCalledWith({
        tenantId,
        couponId,
        actorId,
        operationId,
        reason,
      });
    });

    it.each([
      ["missing operation ID", {}],
      ["non-UUID operation ID", { operationId: "archive-operation" }],
      ["oversized reason", { operationId, reason: "a".repeat(1001) }],
      ["non-string reason", { operationId, reason: 42 }],
      ["body tenant override", { operationId, tenantId: otherTenantId }],
      ["body actor override", { operationId, actorId: otherTenantId }],
      ["body voucher override", { operationId, couponId: otherTenantId }],
      ["unrelated voucher mutation", { operationId, isActive: false }],
    ])("rejects %s without changing the voucher", async (_label, body) => {
      await request(app)
        .patch(route)
        .set("x-auth-context", "workspace")
        .set("x-manage", "true")
        .send(body)
        .expect(400);

      expect(mocks.archive).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
    });

    it("rejects an invalid voucher ID before invoking the service", async () => {
      await request(app)
        .patch(`/coupons/promo-codes/not-an-object-id/${action}`)
        .set("x-auth-context", "workspace")
        .set("x-manage", "true")
        .send({ operationId })
        .expect(400);

      expect(mocks.archive).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
    });
  },
);
