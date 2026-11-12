import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const verifyJWT = vi.fn((req, _res, next) => {
    req.userInfo = {
      authContext: req.get("x-auth-context") || "workspace",
    };
    next();
  });
  const requirePermission = vi.fn((permission: string) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermission: permission });
    return middleware;
  });
  const requireLocationAccess = vi.fn(() => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspaceLocationAccess: true });
    return middleware;
  });

  return {
    verifyJWT,
    requirePermission,
    requireLocationAccess,
    handler: vi.fn((_req, res) => res.status(200).json({ ok: true })),
  };
});

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: mocks.verifyJWT,
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireLocationAccess: mocks.requireLocationAccess,
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/modules/location/controllers/location.controller.js", () => ({
  activateLocation: mocks.handler,
  bootstrapLocation: mocks.handler,
  createLocation: mocks.handler,
  deactivateLocation: mocks.handler,
  deleteLocation: mocks.handler,
  getCustomerLocations: mocks.handler,
  getLocationById: mocks.handler,
  getLocations: mocks.handler,
  setPrimaryLocation: mocks.handler,
  updateLocation: mocks.handler,
}));

import locationRouter from "@/modules/location/routes/location.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

type TaggedHandle = {
  workspaceLocationAccess?: boolean;
  workspacePermission?: string;
};

type RouterLayer = {
  handle: TaggedHandle;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: TaggedHandle; method?: string }>;
  };
};

const routeTags = (path: string, method: string) => {
  const layer = (locationRouter.stack as unknown as RouterLayer[]).find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method] === true,
  );

  expect(
    layer,
    `${method.toUpperCase()} ${path} must be registered`,
  ).toBeDefined();

  return {
    permissions:
      layer?.route?.stack
        .filter((routeLayer) => routeLayer.method === method)
        .map(({ handle }) => handle.workspacePermission)
        .filter((value): value is string => Boolean(value)) ?? [],
    locationScoped: Boolean(
      layer?.route?.stack.some(
        ({ handle, method: routeMethod }) =>
          routeMethod === method && handle.workspaceLocationAccess,
      ),
    ),
  };
};

const app = express();
app.use(locationRouter);
app.use((error: any, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ code: error.code });
});

describe("location route authorization", () => {
  it("allows customer tokens only on the customer-safe location route", async () => {
    await request(app)
      .get("/customer")
      .set("x-auth-context", "customer")
      .expect(200);

    const denied = await request(app)
      .get("/")
      .set("x-auth-context", "customer")
      .expect(403);

    expect(denied.body).toEqual({ code: "WORKSPACE_SESSION_REQUIRED" });
  });

  it("does not allow a workspace token to use the customer route", async () => {
    const denied = await request(app)
      .get("/customer")
      .set("x-auth-context", "workspace")
      .expect(403);

    expect(denied.body).toEqual({ code: "CUSTOMER_SESSION_REQUIRED" });
  });

  it("requires location view permission on both workspace reads", () => {
    expect(routeTags("/", "get")).toEqual({
      permissions: [WORKSPACE_PERMISSION.LOCATIONS_VIEW],
      locationScoped: false,
    });
    expect(routeTags("/:id", "get")).toEqual({
      permissions: [WORKSPACE_PERMISSION.LOCATIONS_VIEW],
      locationScoped: true,
    });
  });

  it("keeps location writes behind management permission and item scope", () => {
    expect(routeTags("/:id", "patch")).toEqual({
      permissions: [WORKSPACE_PERMISSION.LOCATIONS_MANAGE],
      locationScoped: true,
    });
    expect(routeTags("/:id", "delete")).toEqual({
      permissions: [WORKSPACE_PERMISSION.LOCATIONS_MANAGE],
      locationScoped: true,
    });
  });
});
