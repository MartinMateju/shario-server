import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: {
    plan: "professional",
    modules: {
      payments: true,
      credits: true,
      bookings: false,
      courses: false,
      firing: true,
    },
  },
  quoteVoucherCheckout: vi.fn(),
  cancelVoucherPayment: vi.fn(),
  sendCheckout: vi.fn((_req, res) => res.status(200).json({ ok: true })),
  checkoutWithCredits: vi.fn((_req, res) => res.status(200).json({ ok: true })),
  findCustomer: vi.fn(),
  requestRefundParticipants: vi.fn((_req, res) => res.status(200).json({ ok: true })),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req, _res, next) => {
    req.tenant = mocks.tenant;
    req.userInfo = {
      id: "507f1f77bcf86cd799439012",
      tenant: "507f1f77bcf86cd799439011",
      authContext:
        req.get("x-auth-context") === "workspace" ? "workspace" : "customer",
    };
    next();
  },
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.findCustomer },
}));

vi.mock("@/modules/checkout/controllers/checkout.controller.js", () => ({
  quoteCheckout: vi.fn(),
  checkoutWithMembership: vi.fn(),
  quoteVoucherCheckout: mocks.quoteVoucherCheckout,
  cancelVoucherPayment: mocks.cancelVoucherPayment,
  sendCheckout: mocks.sendCheckout,
  checkoutWithCredits: mocks.checkoutWithCredits,
  getCheckoutOrderStatus: vi.fn(),
  confirmIncreaseParticipants: vi.fn(),
  requestRefundParticipants: mocks.requestRefundParticipants,
}));

import checkoutRouter from "@/modules/checkout/checkout.routes.js";

const app = express();
app.use(express.json());
app.use(checkoutRouter);

const checkoutBody = (type: string) => ({
  cart: [
    {
      product: {
        _id: "507f1f77bcf86cd799439012",
        type,
      },
      quantity: 1,
    },
  ],
});

describe("authenticated checkout module guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCustomer.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ isEmailVerified: false, platformRole: "none" }),
    });
    mocks.tenant.modules = {
      payments: true,
      credits: true,
      bookings: false,
      courses: false,
      firing: true,
    };
  });

  it("rejects workspace-context credentials at checkout", async () => {
    await request(app)
      .post("/")
      .set("x-auth-context", "workspace")
      .send(checkoutBody("service"))
      .expect(403);

    expect(mocks.sendCheckout).not.toHaveBeenCalled();
  });

  it.each(["bookings", "courses"] as const)("allows standalone services when %s is enabled", async (module) => {
    mocks.tenant.modules[module] = true;
    await request(app).post("/").send(checkoutBody("service")).expect(200);
    expect(mocks.sendCheckout).toHaveBeenCalledOnce();
  });

  it("does not accept a retired firing entitlement for service checkout", async () => {
    const response = await request(app).post("/").send(checkoutBody("service")).expect(403);
    expect(response.body).toMatchObject({
      code: "TENANT_MODULE_REQUIRED",
      requiredModules: ["bookings", "courses"],
    });
    expect(response.body.message).not.toContain("firing");
    expect(mocks.sendCheckout).not.toHaveBeenCalled();
  });

  it.each(["/", "/credits"])("allows unverified customers to book through %s while checking their tenant account", async (path) => {
    mocks.tenant.modules.bookings = true;
    await request(app).post(path).send(checkoutBody("workshop")).expect(200);
    expect(mocks.findCustomer).toHaveBeenCalledWith({
      _id: "507f1f77bcf86cd799439012",
      tenant: "507f1f77bcf86cd799439011",
      isAccessGranted: true,
    });
    expect(path === "/" ? mocks.sendCheckout : mocks.checkoutWithCredits).toHaveBeenCalledOnce();
  });

  it("preserves email verification for participant refund requests", async () => {
    await request(app).post("/participants/refund-request").send({}).expect(403);
    expect(mocks.requestRefundParticipants).not.toHaveBeenCalled();
  });

  it("requires bookings for workshop checkout", async () => {
    const response = await request(app)
      .post("/")
      .send(checkoutBody("public-workshop"))
      .expect(403);

    expect(response.body).toMatchObject({
      code: "TENANT_MODULE_REQUIRED",
      requiredModule: "bookings",
    });
    expect(mocks.sendCheckout).not.toHaveBeenCalled();
  });

  it("requires courses as well as bookings for course checkout", async () => {
    mocks.tenant.modules.bookings = true;

    const response = await request(app)
      .post("/")
      .send(checkoutBody("public-course"))
      .expect(403);

    expect(response.body).toMatchObject({
      code: "TENANT_MODULE_REQUIRED",
      requiredModule: "courses",
    });
  });

  it("allows a courses-only studio without room bookings", async () => {
    mocks.tenant.modules.courses = true;

    await request(app)
      .post("/")
      .send(checkoutBody("public-course"))
      .expect(200);

    expect(mocks.sendCheckout).toHaveBeenCalledOnce();
  });

  it("rejects checkout when payments are disabled", async () => {
    mocks.tenant.modules.payments = false;

    const response = await request(app)
      .post("/")
      .send(checkoutBody("service"))
      .expect(403);

    expect(response.body).toMatchObject({ requiredModule: "payments" });
  });

  it("requires the credits module for credits checkout", async () => {
    mocks.tenant.modules.credits = false;

    const response = await request(app)
      .post("/credits")
      .send(checkoutBody("service"))
      .expect(403);

    expect(response.body).toMatchObject({ requiredModule: "credits" });
    expect(mocks.checkoutWithCredits).not.toHaveBeenCalled();
  });
});
