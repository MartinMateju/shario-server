import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: {
    plan: "professional",
    modules: {
      payments: true,
      courses: true,
    },
  },
  getCustomerCourseCatalog: vi.fn((_req, res) => res.status(200).json({products: []})),
  getPublicCourseSessions: vi.fn((_req, res) => res.status(200).json({sessions: []})),
  getCustomerCatalog: vi.fn((_req, res) =>
    res.status(200).json({ products: [] }),
  ),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req, _res, next) => {
    req.tenant = mocks.tenant;
    req.userInfo = {
      id: "507f1f77bcf86cd799439012",
      tenant: "507f1f77bcf86cd799439011",
      authContext:
        req.get("x-auth-context") === "workspace"
          ? "workspace"
          : "customer",
    };
    next();
  },
}));

vi.mock("@/modules/product/controllers/product.controller.js", () => ({
  createProduct: vi.fn(),
  deleteProduct: vi.fn(),
  getCustomerCourseCatalog: mocks.getCustomerCourseCatalog,
  getPublicCourseSessions: mocks.getPublicCourseSessions,
  getCustomerCatalog: mocks.getCustomerCatalog,
  getCourseProducts: vi.fn(),
  getProducts: vi.fn(),
  getVoucherAllowance: vi.fn(),
  getProductDeletionPolicy: vi.fn(),
  updateProduct: vi.fn(),
  uploadCouponTemplate: vi.fn(),
}));

import productRouter from "@/modules/product/routes/product.routes.js";

const app = express();
app.use(productRouter);

describe("authenticated customer product catalog route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenant.modules.payments = true;
    mocks.tenant.modules.courses = true;
  });

  it.each(["/customer-catalog/courses", "/customer-catalog/507f1f77bcf86cd799439020/sessions"])(
    "keeps %s authenticated, customer-only and guarded by both modules", async path => {
      await request(app).get(path).expect(200);
      await request(app).get(path).set("x-auth-context", "workspace").expect(403);
      mocks.tenant.modules.courses = false;
      expect((await request(app).get(path).expect(403)).body.requiredModule).toBe("courses");
      mocks.tenant.modules.courses = true;
      mocks.tenant.modules.payments = false;
      expect((await request(app).get(path).expect(403)).body.requiredModule).toBe("payments");
    },
  );

  it("allows a customer without evaluating a workspace permission", async () => {
    await request(app).get("/customer-catalog").expect(200);

    expect(mocks.getCustomerCatalog).toHaveBeenCalledOnce();
  });

  it("rejects a workspace-context token at the customer catalog", async () => {
    await request(app)
      .get("/customer-catalog")
      .set("x-auth-context", "workspace")
      .expect(403);

    expect(mocks.getCustomerCatalog).not.toHaveBeenCalled();
  });

  it("requires the payments module", async () => {
    mocks.tenant.modules.payments = false;

    const response = await request(app).get("/customer-catalog").expect(403);

    expect(response.body).toMatchObject({
      requiredModule: "payments",
    });
    expect(mocks.getCustomerCatalog).not.toHaveBeenCalled();
  });
});
