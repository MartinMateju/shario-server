import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handler = (_req: unknown, _res: unknown, next: () => void) => next();
  const aiModule = vi.fn(handler);
  const knowledgeHub = vi.fn(handler);
  return {
    handler,
    aiModule,
    knowledgeHub,
    requireTenantModule: vi.fn(() => aiModule),
    requireTenantAiCapability: vi.fn(() => knowledgeHub),
    verifyJwt: vi.fn(handler),
    customerSession: vi.fn(handler),
    loadAuthenticatedTenant: vi.fn(handler),
    loadPublishedTenant: vi.fn(handler),
    publicLimiter: vi.fn(handler),
    requireWorkspaceAccess: vi.fn(handler),
    requirePermission: vi.fn((permission: string) => {
      const middleware = (_req: unknown, _res: unknown, next: () => void) =>
        next();
      Object.assign(middleware, { workspacePermission: permission });
      return middleware;
    }),
  };
});

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: mocks.verifyJwt,
}));
vi.mock("@/modules/auth/middleware/requireAuthContext.js", () => ({
  requireCustomerSession: mocks.customerSession,
}));
vi.mock("@/modules/tenants/middleware/loadAuthenticatedTenant.js", () => ({
  loadAuthenticatedTenant: mocks.loadAuthenticatedTenant,
}));
vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicTenantLookupLimiter: mocks.publicLimiter,
}));
vi.mock("@/modules/setup-center/setup-publication.middleware.js", () => ({
  loadPublishedTenant: mocks.loadPublishedTenant,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireWorkspaceAccess: mocks.requireWorkspaceAccess,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/tenants/middleware/requireTenantModule.js", () => ({
  requireTenantModule: mocks.requireTenantModule,
}));
vi.mock("@/modules/tenants/middleware/requireTenantPlanCapability.js", () => ({
  requireTenantAiCapability: mocks.requireTenantAiCapability,
}));
vi.mock("@/modules/communications/controllers/knowledge.controller.js", () => ({
  createWorkspaceKnowledge: mocks.handler,
  deleteWorkspaceKnowledge: mocks.handler,
  getCustomerKnowledge: mocks.handler,
  getPublicKnowledge: mocks.handler,
  getWorkspaceKnowledge: mocks.handler,
  listCustomerKnowledge: mocks.handler,
  listPublicKnowledge: mocks.handler,
  listWorkspaceKnowledge: mocks.handler,
  updateWorkspaceKnowledge: mocks.handler,
}));

import {
  customerKnowledgeRouter,
  publicKnowledgeRouter,
  workspaceKnowledgeRouter,
} from "@/modules/communications/routes/knowledge.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

type Layer = {
  handle?: unknown;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      method?: string;
      handle: { workspacePermission?: string };
    }>;
  };
};

const route = (router: { stack: Layer[] }, path: string, method: string) => {
  const match = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );
  expect(match).toBeDefined();
  return match!;
};

describe("canonical knowledge routes", () => {
  it("gates customer reads by customer authentication and Knowledge Hub entitlement", () => {
    expect(mocks.requireTenantModule).toHaveBeenCalledWith(TENANT_MODULE.AI);
    expect(mocks.requireTenantAiCapability).toHaveBeenCalledWith(
      "knowledgeHub",
    );
    for (const path of ["/customer", "/customer/:id"]) {
      const customerRoute = route(
        customerKnowledgeRouter as unknown as { stack: Layer[] },
        path,
        "get",
      );
      expect(customerRoute.route!.stack.map((entry) => entry.handle)).toEqual([
        mocks.verifyJwt,
        mocks.customerSession,
        mocks.loadAuthenticatedTenant,
        mocks.aiModule,
        mocks.knowledgeHub,
        mocks.handler,
      ]);
    }
  });

  it("rate-limits public reads and checks publication before Knowledge Hub entitlement", () => {
    for (const path of [
      "/tenants/:tenantSlug/knowledge",
      "/tenants/:tenantSlug/knowledge/:id",
    ]) {
      const publicRoute = route(
        publicKnowledgeRouter as unknown as { stack: Layer[] },
        path,
        "get",
      );
      expect(publicRoute.route!.stack.map((entry) => entry.handle)).toEqual([
        mocks.publicLimiter,
        mocks.loadPublishedTenant,
        mocks.aiModule,
        mocks.knowledgeHub,
        mocks.handler,
      ]);
    }
  });

  it("uses dedicated view and manage permissions for workspace CRUD", () => {
    expect(
      (workspaceKnowledgeRouter as unknown as { stack: Layer[] }).stack
        .filter((layer) => !layer.route)
        .map((layer) => layer.handle),
    ).toEqual([mocks.requireWorkspaceAccess, mocks.aiModule]);
    const permissions = (path: string, method: string) =>
      route(
        workspaceKnowledgeRouter as unknown as { stack: Layer[] },
        path,
        method,
      )
        .route!.stack.filter(
          (entry) => !entry.method || entry.method === method,
        )
        .map((entry) => entry.handle.workspacePermission)
        .filter(Boolean);

    expect(permissions("/", "get")).toEqual([
      WORKSPACE_PERMISSION.KNOWLEDGE_VIEW,
    ]);
    expect(permissions("/:id", "get")).toEqual([
      WORKSPACE_PERMISSION.KNOWLEDGE_VIEW,
    ]);
    for (const [path, method] of [
      ["/", "post"],
      ["/:id", "patch"],
      ["/:id", "delete"],
    ] as const) {
      expect(permissions(path, method)).toEqual([
        WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE,
      ]);
    }
  });
});
