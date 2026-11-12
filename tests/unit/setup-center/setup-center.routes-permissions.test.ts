import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  const verifyJWT = vi.fn((_req, _res, next) => next());
  const requireWorkspaceAccess = vi.fn((_req, _res, next) => next());
  const requirePermission = vi.fn((...permissions: string[]) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermissions: permissions });
    return middleware;
  });
  return {
    verifyJWT,
    requireWorkspaceAccess,
    requirePermission,
    handler: vi.fn(),
  };
});

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: routeMocks.verifyJWT,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireWorkspaceAccess: routeMocks.requireWorkspaceAccess,
  requirePermission: routeMocks.requirePermission,
}));
vi.mock("@/modules/setup-center/setup-center.controller.js", () => ({
  abandonPractice: routeMocks.handler,
  advancePractice: routeMocks.handler,
  confirmPractice: routeMocks.handler,
  clearPracticeConfirmation: routeMocks.handler,
  getSetupAssistantResponse: routeMocks.handler,
  getSetupCenter: routeMocks.handler,
  publishCurrentStudio: routeMocks.handler,
  startPractice: routeMocks.handler,
  trackSetupLaunchEvent: routeMocks.handler,
  unpublishCurrentStudio: routeMocks.handler,
}));

import { setupCenterRouter } from "@/modules/setup-center/setup-center.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

type RouterLayer = {
  handle: {
    workspacePermissions?: string[];
  };
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: {
        workspacePermissions?: string[];
      };
    }>;
  };
};

const stack = setupCenterRouter.stack as unknown as RouterLayer[];

const findRoute = (path: string, method: string) => {
  const layer = stack.find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method] === true,
  );
  expect(
    layer,
    `${method.toUpperCase()} ${path} must be registered`,
  ).toBeDefined();
  return layer!;
};

const routePermissions = (path: string, method: string): string[][] =>
  findRoute(path, method)
    .route!.stack.map(({ handle }) => handle.workspacePermissions)
    .filter((value): value is string[] => Boolean(value));

describe("Setup Center route authorization", () => {
  it("orders authentication and active workspace access before every route", () => {
    expect(stack[0]?.handle).toBe(routeMocks.verifyJWT);
    expect(stack[1]?.handle).toBe(routeMocks.requireWorkspaceAccess);
    expect(stack[2]?.route).toBeDefined();
  });

  it("allows workspace viewers to read Setup Center diagnostics", () => {
    expect(routePermissions("/", "get")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_VIEW],
    ]);
  });

  it("allows setup managers to use deterministic setup help", () => {
    expect(routePermissions("/assistant", "post")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_UPDATE],
    ]);
  });

  it("allows authenticated workspace viewers to submit tenant-scoped telemetry", () => {
    expect(routePermissions("/events", "post")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_VIEW],
    ]);
  });

  it.each([
    ["/practice", "post"],
    ["/practice/actions/:action", "post"],
    ["/practice", "delete"],
    ["/practice/confirmation", "post"],
    ["/practice/confirmation", "delete"],
  ] as const)(
    "adds product visibility and booking creation permission to %s %s",
    (path, method) => {
      expect(routePermissions(path, method)).toEqual([
        [WORKSPACE_PERMISSION.WORKSPACE_UPDATE],
        [
          WORKSPACE_PERMISSION.PRODUCTS_VIEW,
          WORKSPACE_PERMISSION.BOOKINGS_CREATE,
        ],
      ]);
    },
  );

  it.each([
    ["/publish", "post"],
    ["/unpublish", "post"],
  ] as const)(
    "reserves publication state changes for workspace owners on %s %s",
    (path, method) => {
      expect(routePermissions(path, method)).toEqual([
        [WORKSPACE_PERMISSION.WORKSPACE_PUBLISH],
      ]);
    },
  );

  it("mounts setup recovery before the tenant feature-subscription boundary", () => {
    const source = readFileSync(
      new URL("../../../src/app/routes.ts", import.meta.url),
      "utf8",
    );
    const setupMount = source.indexOf('"/tenants/current/setup-center"');
    const subscriptionBoundary = source.indexOf(
      "apiRouter.use(verifyJWT, requireTenantSubscriptionAccess);",
    );

    expect(setupMount).toBeGreaterThan(-1);
    expect(subscriptionBoundary).toBeGreaterThan(-1);
    expect(setupMount).toBeLessThan(subscriptionBoundary);
  });
});
