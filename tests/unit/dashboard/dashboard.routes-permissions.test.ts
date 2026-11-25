import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn((_req, _res, next) => next()),
  permission: vi.fn((permission: string) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { permission });
    return middleware;
  }),
  handler: vi.fn(),
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireWorkspaceAccess: mocks.workspace,
  requirePermission: mocks.permission,
}));

vi.mock("@/modules/dashboard/dashboard.controller.js", () => ({
  getDashboardOverview: mocks.handler,
  getDashboardManagement: mocks.handler,
  createDashboardReport: mocks.handler,
  downloadDashboardReportPdf: mocks.handler,
}));

import dashboardRouter from "@/modules/dashboard/dashboard.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

describe("dashboard route permissions", () => {
  it("requires active workspace access for the router", () => {
    expect(
      (dashboardRouter.stack as any[]).some(
        (entry) => entry.handle === mocks.workspace,
      ),
    ).toBe(true);
  });

  it("requires workspace.view for the overview", () => {
    const layer = (dashboardRouter.stack as any[]).find(
      (entry) => entry.route?.path === "/overview" && entry.route.methods.get,
    );

    expect(layer).toBeDefined();
    expect(
      layer.route.stack
        .map((entry: any) => entry.handle.permission)
        .filter(Boolean),
    ).toEqual([WORKSPACE_PERMISSION.WORKSPACE_VIEW]);
  });

  it.each([
    [
      "/management",
      "get",
      [WORKSPACE_PERMISSION.WORKSPACE_VIEW, WORKSPACE_PERMISSION.REPORTS_VIEW],
    ],
    [
      "/reports",
      "post",
      [
        WORKSPACE_PERMISSION.WORKSPACE_VIEW,
        WORKSPACE_PERMISSION.REPORTS_VIEW,
        WORKSPACE_PERMISSION.AI_USE,
      ],
    ],
    [
      "/reports/:reportId/pdf",
      "get",
      [
        WORKSPACE_PERMISSION.WORKSPACE_VIEW,
        WORKSPACE_PERMISSION.REPORTS_VIEW,
        WORKSPACE_PERMISSION.REPORTS_EXPORT,
      ],
    ],
  ])(
    "protects %s with the appropriate read/generate/export permissions",
    (path, method, permissions) => {
      const layer = (dashboardRouter.stack as any[]).find(
        (entry) =>
          entry.route?.path === path && entry.route.methods[method as string],
      );
      expect(layer).toBeDefined();
      expect(
        layer.route.stack
          .map((entry: any) => entry.handle.permission)
          .filter(Boolean),
      ).toEqual(permissions);
    },
  );
});
