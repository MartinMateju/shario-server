import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: null as any,
  loadTenant: vi.fn(),
  controller: vi.fn((_req, res) => res.json({ data: { items: [] } })),
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
    // Simulate an unrelated context left by a domain resolver. The loader must
    // still use the authenticated tenant before deciding feature access.
    if (req.get("x-unrelated-context")) {
      req.tenant = {
        plan: "studio_plus",
        planVersion: 3,
        modules: { ai: true },
      };
    }
    next();
  },
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.loadTenant,
}));
vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicTenantLookupLimiter: (_req, _res, next) => next(),
}));
vi.mock("@/modules/setup-center/setup-publication.middleware.js", () => ({
  loadPublishedTenant: (req, _res, next) => {
    req.tenant = mocks.tenant;
    next();
  },
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireWorkspaceAccess: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
vi.mock("@/modules/communications/controllers/knowledge.controller.js", () => ({
  createWorkspaceKnowledge: mocks.controller,
  deleteWorkspaceKnowledge: mocks.controller,
  getCustomerKnowledge: mocks.controller,
  getPublicKnowledge: mocks.controller,
  getWorkspaceKnowledge: mocks.controller,
  listCustomerKnowledge: mocks.controller,
  listPublicKnowledge: mocks.controller,
  listWorkspaceKnowledge: mocks.controller,
  updateWorkspaceKnowledge: mocks.controller,
}));

import {
  customerKnowledgeRouter,
  publicKnowledgeRouter,
} from "@/modules/communications/routes/knowledge.routes.js";
import { notFound } from "@/shared/http/httpErrors.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const app = express();
app.use("/knowledge", customerKnowledgeRouter);
app.use("/public", publicKnowledgeRouter);
app.use(errorHandler);
const paths = [
  "/knowledge/customer",
  "/knowledge/customer/507f1f77bcf86cd799439013",
];

describe("customer knowledge tenant context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenant = {
      _id: "507f1f77bcf86cd799439011",
      plan: "professional",
      planVersion: 3,
      modules: { ai: true },
    };
    mocks.loadTenant.mockImplementation(async () => mocks.tenant);
  });

  it.each(paths)(
    "hydrates authenticated tenant before real entitlement guards on %s",
    async (path) => {
      await request(app)
        .get(path)
        .set("x-auth-context", "customer")
        .expect(200, { data: { items: [] } });
      expect(mocks.loadTenant).toHaveBeenCalledWith("507f1f77bcf86cd799439011");
      expect(mocks.controller).toHaveBeenCalledOnce();
      expect(mocks.controller.mock.calls[0]?.[0].tenant).toBe(mocks.tenant);
    },
  );

  it("does not load tenant or content before customer authentication", async () => {
    await request(app).get(paths[0]!).expect(401);
    await request(app)
      .get(paths[0]!)
      .set("x-auth-context", "workspace")
      .expect(403);
    expect(mocks.loadTenant).not.toHaveBeenCalled();
    expect(mocks.controller).not.toHaveBeenCalled();
  });

  it("preserves disabled-module restrictions", async () => {
    mocks.tenant.modules.ai = false;
    const response = await request(app)
      .get(paths[0]!)
      .set("x-auth-context", "customer")
      .expect(403);
    expect(response.body.code).toBe("TENANT_MODULE_DISABLED");
    expect(mocks.controller).not.toHaveBeenCalled();
  });

  it("uses the authenticated tenant's plan instead of unrelated request context", async () => {
    mocks.tenant.plan = "starter";
    const response = await request(app)
      .get(`${paths[0]}?tenantId=507f1f77bcf86cd799439099`)
      .set("x-auth-context", "customer")
      .set("x-unrelated-context", "yes")
      .expect(403);
    expect(response.body).toMatchObject({
      code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
      details: {
        capability: "knowledgeHub",
        currentPlan: "starter",
        planVersion: 3,
      },
    });
    expect(mocks.loadTenant).toHaveBeenCalledWith("507f1f77bcf86cd799439011");
    expect(mocks.controller).not.toHaveBeenCalled();
  });

  it.each([
    "/public/tenants/clay/knowledge",
    "/public/tenants/clay/knowledge/507f1f77bcf86cd799439013",
  ])(
    "allows published Professional guide content at %s without changing Starter access",
    async (path) => {
      await request(app)
        .get(path)
        .expect(200, { data: { items: [] } });
      expect(mocks.controller).toHaveBeenCalledOnce();
      expect(mocks.loadTenant).not.toHaveBeenCalled();
      mocks.tenant.plan = "starter";
      const response = await request(app).get(path).expect(403);
      expect(response.body.code).toBe("TENANT_PLAN_CAPABILITY_NOT_ENTITLED");
      expect(mocks.controller).toHaveBeenCalledOnce();
    },
  );

  it("stops when the authenticated tenant no longer exists", async () => {
    mocks.loadTenant.mockImplementation(async () =>
      notFound("Tenant not found"),
    );
    await request(app)
      .get(paths[0]!)
      .set("x-auth-context", "customer")
      .expect(404);
    expect(mocks.controller).not.toHaveBeenCalled();
  });
});
