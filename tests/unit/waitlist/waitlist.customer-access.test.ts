import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customer: null as any,
  findCustomer: vi.fn(),
  reconcile: vi.fn(),
  list: vi.fn(),
  withdraw: vi.fn(),
  join: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.findCustomer },
}));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req, _res, next) => {
    if (req.get("x-auth-context")) {
      req.userInfo = {
        id: req.get("x-user") || "507f1f77bcf86cd799439012",
        tenant: req.get("x-tenant") || "507f1f77bcf86cd799439011",
        email: "stale-token-email@example.com",
        authContext: req.get("x-auth-context"),
      };
      req.tenant = {
        plan: "professional",
        modules: { courses: true, payments: true },
      };
    }
    next();
  },
}));
vi.mock(
  "@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js",
  () => ({
    requireTenantSubscriptionAccess: (_req, _res, next) => next(),
  }),
);
vi.mock("@/modules/checkout/controllers/checkout.controller.js", () => ({
  sendWaitlistEntryCheckout: (_req, res) => res.sendStatus(200),
}));
vi.mock("@/modules/waitlist/waitlist.checkout.service.js", () => ({
  reconcileGuestEntryToCustomer: mocks.reconcile,
}));
vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  joinCustomerWaitlist: mocks.join,
  listCustomerWaitlistEntries: mocks.list,
  withdrawWaitlistEntry: mocks.withdraw,
}));

import customerWaitlistRouter from "@/modules/waitlist/waitlist.customer.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const CUSTOMER_ID = "507f1f77bcf86cd799439012";
const SESSION_ID = "507f1f77bcf86cd799439013";
const ENTRY_ID = "507f1f77bcf86cd799439014";
const app = express();
app.use(express.json());
app.use("/waitlist", customerWaitlistRouter);
app.use(errorHandler);

describe("customer waitlist ownership without email verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.customer = {
      _id: CUSTOMER_ID,
      tenant: TENANT_ID,
      email: "current@example.com",
      firstname: "Clay",
      lastname: "Maker",
      isEmailVerified: false,
      isAccessGranted: true,
      platformRole: "none",
    };
    mocks.findCustomer.mockImplementation((filter) => ({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi
        .fn()
        .mockResolvedValue(
          mocks.customer &&
            filter._id === mocks.customer._id &&
            filter.tenant === mocks.customer.tenant &&
            filter.isAccessGranted === mocks.customer.isAccessGranted
            ? mocks.customer
            : null,
        ),
    }));
    mocks.list.mockResolvedValue([{ id: ENTRY_ID, state: "waiting" }]);
    mocks.withdraw.mockResolvedValue({ id: ENTRY_ID, state: "withdrawn" });
    mocks.reconcile.mockResolvedValue(undefined);
    mocks.join.mockResolvedValue({ entry: { id: ENTRY_ID }, created: true });
  });

  it("returns existing account-owned history without claiming same-email guest entries", async () => {
    await request(app)
      .get("/waitlist/mine")
      .set("x-auth-context", "customer")
      .expect("Cache-Control", "private, no-store")
      .expect(200, { entries: [{ id: ENTRY_ID, state: "waiting" }] });

    expect(mocks.list).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
      sessionId: undefined,
    });
    expect(mocks.findCustomer).toHaveBeenLastCalledWith({
      _id: CUSTOMER_ID,
      tenant: TENANT_ID,
      isAccessGranted: true,
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.customer.isEmailVerified).toBe(false);
  });

  it("keeps the empty and session-specific response contracts", async () => {
    mocks.list.mockResolvedValue([]);
    await request(app)
      .get("/waitlist/mine")
      .set("x-auth-context", "customer")
      .expect(200, { entries: [] });
    await request(app)
      .get(`/waitlist/mine?sessionId=${SESSION_ID}`)
      .set("x-auth-context", "customer")
      .expect(200, { entry: null });
    expect(mocks.list).toHaveBeenLastCalledWith({
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
      sessionId: SESSION_ID,
    });
  });

  it("allows withdrawing only the authenticated customer's entry without email reconciliation", async () => {
    await request(app)
      .delete(`/waitlist/entries/${ENTRY_ID}`)
      .set("x-auth-context", "customer")
      .expect(200, { entry: { id: ENTRY_ID, state: "withdrawn" } });
    expect(mocks.withdraw).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
      entryId: ENTRY_ID,
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.customer.isEmailVerified).toBe(false);
  });

  it("reconciles guest entries only after persisted verification, using current account details", async () => {
    mocks.customer.isEmailVerified = true;
    await request(app)
      .get("/waitlist/mine")
      .set("x-auth-context", "customer")
      .expect(200);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
      email: "current@example.com",
    });
  });

  it("continues to require verification when joining a new waitlist", async () => {
    const result = await request(app)
      .post("/waitlist/entries")
      .set("x-auth-context", "customer")
      .send({ sessionId: SESSION_ID })
      .expect(403);
    expect(result.body.code).toBe("EMAIL_VERIFICATION_REQUIRED");
    expect(mocks.join).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    mocks.customer.isEmailVerified = true;
    await request(app)
      .post("/waitlist/entries")
      .set("x-auth-context", "customer")
      .send({ sessionId: SESSION_ID, locale: "en" })
      .expect(201);
    expect(mocks.join).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        customer: expect.objectContaining({
          customerId: CUSTOMER_ID,
          email: "current@example.com",
        }),
      }),
    );
  });

  it.each(["get", "delete"] as const)(
    "rejects missing, workspace, foreign-tenant and foreign-account principals for %s",
    async (method) => {
      const path =
        method === "get" ? "/waitlist/mine" : `/waitlist/entries/${ENTRY_ID}`;
      await request(app)[method](path).expect(401);
      await request(app)
        [method](path)
        .set("x-auth-context", "workspace")
        .expect(403);
      await request(app)
        [method](path)
        .set("x-auth-context", "customer")
        .set("x-tenant", "507f1f77bcf86cd799439099")
        .expect(404);
      await request(app)
        [method](path)
        .set("x-auth-context", "customer")
        .set("x-user", "507f1f77bcf86cd799439099")
        .expect(404);
      mocks.customer.platformRole = "admin";
      await request(app)
        [method](path)
        .set("x-auth-context", "customer")
        .expect(403);
      mocks.customer.platformRole = "none";
      mocks.customer.isAccessGranted = false;
      await request(app)
        [method](path)
        .set("x-auth-context", "customer")
        .expect(404);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.withdraw).not.toHaveBeenCalled();
      expect(mocks.reconcile).not.toHaveBeenCalled();
    },
  );

  it("does not accept a query-provided owner instead of the authenticated customer", async () => {
    await request(app)
      .get(`/waitlist/mine?customerId=${CUSTOMER_ID}`)
      .set("x-auth-context", "customer")
      .expect(400);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
