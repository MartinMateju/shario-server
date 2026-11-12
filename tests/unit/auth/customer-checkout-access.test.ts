import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customer: null as any,
  findCustomer: vi.fn(),
  modules: { courses: true, payments: true },
  handler: vi.fn((_req, res) => res.status(200).json({ ok: true })),
}));

vi.mock("@/modules/user/user.model.js", () => ({ default: { findOne: mocks.findCustomer } }));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req, _res, next) => {
    if (req.get("x-auth-context")) {
      req.userInfo = {
        id: "507f1f77bcf86cd799439012",
        tenant: req.get("x-tenant") || "507f1f77bcf86cd799439011",
        authContext: req.get("x-auth-context"),
      };
      req.tenant = { plan: "professional", modules: mocks.modules };
    }
    next();
  },
}));
vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({ publicTenantLookupLimiter: (_req, _res, next) => next() }));
vi.mock("@/modules/product/routes/product.public.routes.js", () => ({ requirePublicProductSubscription: (_req, _res, next) => next() }));
vi.mock("@/modules/setup-center/setup-publication.middleware.js", () => ({ loadPublishedTenant: (_req, _res, next) => next() }));
vi.mock("@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js", () => ({ requireTenantSubscriptionAccess: (_req, _res, next) => next() }));
vi.mock("@/modules/booking-intent/booking-intent.controller.js", () => ({
  createBookingIntent: mocks.handler,
  getBookingIntent: mocks.handler,
  checkoutBookingIntentController: mocks.handler,
  quoteBookingIntentVoucherController: mocks.handler,
}));
vi.mock("@/modules/waitlist/waitlist.customer.controller.js", () => ({
  getMyWaitlist: mocks.handler, joinWaitlistAsCustomer: mocks.handler, withdrawMyWaitlistEntry: mocks.handler,
}));
vi.mock("@/modules/checkout/controllers/checkout.controller.js", () => ({ sendWaitlistEntryCheckout: mocks.handler }));

import { customerBookingIntentRouter } from "@/modules/booking-intent/booking-intent.routes.js";
import customerWaitlistRouter from "@/modules/waitlist/waitlist.customer.routes.js";

const app = express();
app.use(express.json());
app.use("/intents", customerBookingIntentRouter);
app.use("/waitlist", customerWaitlistRouter);
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }));

describe("booking checkout account access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modules = { courses: true, payments: true };
    mocks.customer = {
      _id: "507f1f77bcf86cd799439012", tenant: "507f1f77bcf86cd799439011",
      isEmailVerified: false, isAccessGranted: true, tenantRole: "customer", platformRole: "none",
    };
    mocks.findCustomer.mockImplementation((filter) => ({
      select: vi.fn().mockReturnThis(), lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(
        mocks.customer && filter._id === mocks.customer._id && filter.tenant === mocks.customer.tenant &&
        filter.isAccessGranted === mocks.customer.isAccessGranted ? mocks.customer : null,
      ),
    }));
  });

  it.each([
    ["get", "/intents/signed-token"],
    ["post", "/intents/signed-token/checkout"],
    ["post", "/intents/signed-token/voucher/quote"],
    ["post", "/waitlist/entries/entry-id/checkout"],
    ["get", "/waitlist/mine"],
    ["delete", "/waitlist/entries/entry-id"],
  ] as const)("allows an unverified customer through %s %s without marking the email verified", async (method, path) => {
    await request(app)[method](path).set("x-auth-context", "customer").expect(200);
    expect(mocks.handler).toHaveBeenCalledOnce();
    expect(mocks.customer.isEmailVerified).toBe(false);
    expect(mocks.findCustomer).toHaveBeenCalledWith({
      _id: mocks.customer._id, tenant: mocks.customer.tenant, isAccessGranted: true,
    });
  });

  it("still rejects missing customer authentication and workspace sessions", async () => {
    await request(app).post("/intents/token/checkout").expect(401);
    await request(app).post("/intents/token/checkout").set("x-auth-context", "workspace").expect(403);
    expect(mocks.findCustomer).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("still rejects platform identities, revoked access, and another tenant's account", async () => {
    mocks.customer.platformRole = "admin";
    await request(app).post("/intents/token/checkout").set("x-auth-context", "customer").expect(403);
    mocks.customer.platformRole = "none";
    mocks.customer.isAccessGranted = false;
    await request(app).post("/intents/token/checkout").set("x-auth-context", "customer").expect(404);
    mocks.customer.isAccessGranted = true;
    await request(app).post("/intents/token/checkout").set("x-auth-context", "customer")
      .set("x-tenant", "507f1f77bcf86cd799439099").expect(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("keeps payment module enforcement for waitlist checkout", async () => {
    mocks.modules.payments = false;
    await request(app).post("/waitlist/entries/entry-id/checkout").set("x-auth-context", "customer").expect(403);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it.each([["post", "/waitlist/entries"]] as const)(
    "preserves email verification for %s %s", async (method, path) => {
      const result = await request(app)[method](path).set("x-auth-context", "customer").expect(403);
      expect(result.body.code).toBe("EMAIL_VERIFICATION_REQUIRED");
      expect(mocks.handler).not.toHaveBeenCalled();
      mocks.customer.isEmailVerified = true;
      await request(app)[method](path).set("x-auth-context", "customer").expect(200);
    },
  );
});
