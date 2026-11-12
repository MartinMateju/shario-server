import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: null as any,
  canUseFeatures: true,
  published: false,
  findTenant: vi.fn(),
  subscription: vi.fn(),
  customerCatalog: vi.fn(),
  publicCatalog: vi.fn(),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req, _res, next) => {
    if (req.get("x-auth-context")) {
      req.userInfo = {
        id: "507f1f77bcf86cd799439012",
        tenant: "507f1f77bcf86cd799439011",
        authContext: req.get("x-auth-context"),
      };
    }
    next();
  },
}));
vi.mock("@/modules/tenants/tenant.repository.js", () => ({
  findTenantById: mocks.findTenant,
}));
vi.mock("@/modules/tenant-subscription/services/tenant-subscription.service.js", () => ({
  getTenantSubscriptionAccess: mocks.subscription,
}));
vi.mock("@/modules/membership/services/membership-plan.service.js", () => ({
  membershipPlanService: {
    customerCatalog: mocks.customerCatalog,
    publicCatalog: mocks.publicCatalog,
  },
}));
vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicTenantLookupLimiter: (_req, _res, next) => next(),
}));
vi.mock("@/modules/setup-center/setup-publication.middleware.js", () => ({
  loadPublishedTenant: (_req, res, next) =>
    mocks.published ? next() : res.sendStatus(404),
}));
vi.mock("@/modules/product/routes/product.public.routes.js", () => ({
  requirePublicProductSubscription: (_req, _res, next) => next(),
  requirePublicProductModule: () => (_req, _res, next) => next(),
}));

import {
  customerMembershipRouter,
  publicMembershipRouter,
} from "@/modules/membership/routes/membership.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const LOCATION_ID = "507f1f77bcf86cd799439013";
const app = express();
app.use("/memberships", customerMembershipRouter);
app.use("/public", publicMembershipRouter);
app.use(errorHandler);

describe("authenticated membership catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenant = {
      _id: TENANT_ID,
      plan: "professional",
      modules: { memberships: true, payments: true },
    };
    mocks.canUseFeatures = true;
    mocks.published = false;
    mocks.findTenant.mockResolvedValue(mocks.tenant);
    mocks.subscription.mockImplementation(async () => ({
      tenant: mocks.tenant,
      access: { canUseFeatures: mocks.canUseFeatures },
    }));
    mocks.customerCatalog.mockResolvedValue({ tenant: { id: TENANT_ID }, locations: [], plans: [] });
  });

  it("serves customers from their authenticated tenant while the public website is unpublished", async () => {
    const response = await request(app)
      .get(`/memberships/catalog?locationId=${LOCATION_ID}`)
      .set("x-auth-context", "customer")
      .set("Host", "unrelated.shario.io")
      .expect(200);
    expect(response.body).toEqual({ tenant: { id: TENANT_ID }, locations: [], plans: [] });
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(response.headers.vary).toBe("Authorization");
    expect(mocks.findTenant).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.subscription).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.customerCatalog).toHaveBeenCalledWith(TENANT_ID, LOCATION_ID);
    for (const path of ["memberships", "membership-plans"]) {
      await request(app).get(`/public/tenants/clay/${path}`).expect(404);
    }
    expect(mocks.publicCatalog).not.toHaveBeenCalled();
  });

  it("rejects missing and workspace sessions before serving the catalog", async () => {
    await request(app).get("/memberships/catalog").expect(401);
    await request(app).get("/memberships/catalog")
      .set("x-auth-context", "workspace").expect(403);
    expect(mocks.customerCatalog).not.toHaveBeenCalled();
    expect(mocks.subscription).not.toHaveBeenCalled();
  });

  it.each(["memberships", "payments"])("keeps the %s module gate", async (module) => {
    mocks.tenant.modules[module] = false;
    await request(app).get("/memberships/catalog")
      .set("x-auth-context", "customer").expect(403);
    expect(mocks.customerCatalog).not.toHaveBeenCalled();
  });

  it("requires an active tenant subscription", async () => {
    mocks.canUseFeatures = false;
    const response = await request(app).get("/memberships/catalog")
      .set("x-auth-context", "customer").expect(403);
    expect(response.body.code).toBe("TENANT_SUBSCRIPTION_REQUIRED");
    expect(mocks.customerCatalog).not.toHaveBeenCalled();
  });

  it.each(["tenantId=507f1f77bcf86cd799439099", "locationId=foreign-slug", "includeInactive=true"])(
    "rejects unsupported catalog query %s", async (query) => {
      await request(app).get(`/memberships/catalog?${query}`)
        .set("x-auth-context", "customer").expect(400);
      expect(mocks.customerCatalog).not.toHaveBeenCalled();
    },
  );
});
