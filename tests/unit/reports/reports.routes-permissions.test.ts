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
vi.mock("@/modules/reports/reports.controller.js", () => ({
  getReportOverview: mocks.handler,
  exportReportCsv: mocks.handler,
}));

import reportsRouter from "@/modules/reports/reports.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const permissionsFor = (path: string, method: string): string[] => {
  const layer = (reportsRouter.stack as any[]).find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  expect(layer).toBeDefined();
  return layer.route.stack
    .map((entry: any) => entry.handle.permission)
    .filter(Boolean);
};

describe("report route permissions", () => {
  it("requires active workspace access for the router", () => {
    expect(
      (reportsRouter.stack as any[]).some(
        (entry) => entry.handle === mocks.workspace,
      ),
    ).toBe(true);
  });

  it("requires reports.view for overview", () => {
    expect(permissionsFor("/overview", "get")).toEqual([
      WORKSPACE_PERMISSION.REPORTS_VIEW,
    ]);
  });

  it("requires view and export permissions for CSV", () => {
    expect(permissionsFor("/export.csv", "get")).toEqual([
      WORKSPACE_PERMISSION.REPORTS_VIEW,
      WORKSPACE_PERMISSION.REPORTS_EXPORT,
    ]);
  });
});

