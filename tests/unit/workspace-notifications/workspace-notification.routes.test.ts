import { describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  verifyJWT: vi.fn((_req, _res, next) => next()),
  requireWorkspaceSession: vi.fn((_req, _res, next) => next()),
  requireWorkspaceAccess: vi.fn((_req, _res, next) => next()),
  handler: vi.fn(),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: routeMocks.verifyJWT,
}));
vi.mock("@/modules/auth/middleware/requireAuthContext.js", () => ({
  requireWorkspaceSession: routeMocks.requireWorkspaceSession,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireWorkspaceAccess: routeMocks.requireWorkspaceAccess,
}));
vi.mock(
  "@/modules/workspace-notifications/controllers/workspace-notification.controller.js",
  () => ({
    getWorkspaceNotificationSummary: routeMocks.handler,
    listWorkspaceNotifications: routeMocks.handler,
    markAllWorkspaceNotificationsRead: routeMocks.handler,
    markWorkspaceNotificationRead: routeMocks.handler,
  }),
);

import { workspaceNotificationRouter } from "@/modules/workspace-notifications/routes/workspace-notification.routes.js";

type RouterLayer = {
  handle: unknown;
  route?: { path: string; methods: Record<string, boolean> };
};

const stack = workspaceNotificationRouter.stack as unknown as RouterLayer[];

describe("workspace notification routes", () => {
  it("authenticates workspace context and active membership before handlers", () => {
    expect(stack[0]?.handle).toBe(routeMocks.verifyJWT);
    expect(stack[1]?.handle).toBe(routeMocks.requireWorkspaceSession);
    expect(stack[2]?.handle).toBe(routeMocks.requireWorkspaceAccess);
    expect(stack[3]?.route).toBeDefined();
  });

  it.each([
    ["/", "get"],
    ["/summary", "get"],
    ["/read-all", "post"],
    ["/:id/read", "patch"],
  ] as const)("registers %s %s", (path, method) => {
    expect(
      stack.some(
        (layer) =>
          layer.route?.path === path && layer.route.methods[method] === true,
      ),
    ).toBe(true);
  });
});
