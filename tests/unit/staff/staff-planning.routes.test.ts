import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const middleware = vi.fn((_req, _res, next) => next());
  const requirePermission = vi.fn((...permissions: string[]) => {
    const value = vi.fn((_req, _res, next) => next());
    Object.assign(value, { permissions });
    return value;
  });
  const requireAnyPermission = vi.fn((...permissions: string[]) => {
    const value = vi.fn((_req, _res, next) => next());
    Object.assign(value, { permissions });
    return value;
  });
  const requireTenantModule = vi.fn((moduleName: string) => {
    const value = vi.fn((_req, _res, next) => next());
    Object.assign(value, { moduleName });
    return value;
  });
  return {
    middleware,
    requirePermission,
    requireAnyPermission,
    requireTenantModule,
    handler: vi.fn(),
  };
});

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: mocks.middleware,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireWorkspaceAccess: mocks.middleware,
  requirePermission: mocks.requirePermission,
  requireAnyPermission: mocks.requireAnyPermission,
}));
vi.mock("@/modules/tenants/middleware/requireTenantModule.js", () => ({
  requireTenantModule: mocks.requireTenantModule,
}));
vi.mock("@/modules/staff/controllers/staff-planning.controller.js", () => ({
  getStaffPlanningOverview: mocks.handler,
  patchDailyAttention: mocks.handler,
  putDailyUpdate: mocks.handler,
  putMemberSchedule: mocks.handler,
  putMonthlyPriorities: mocks.handler,
  putPlanningSettings: mocks.handler,
  putWeeklyPlan: mocks.handler,
}));

import router from "@/modules/staff/routes/staff-planning.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

const routePermissions = (path: string, method: string) => {
  const route: any = (router.stack as any[]).find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  )?.route;
  expect(route).toBeDefined();
  return route.stack.flatMap(
    (layer: any) => layer.handle.permissions || [],
  );
};

describe("staff planning route contract", () => {
  it("gates only the planning router by the staff_tasks module", () => {
    expect(mocks.requireTenantModule).toHaveBeenCalledWith(
      TENANT_MODULE.STAFF_TASKS,
    );
  });

  it("separates self submission from team management", () => {
    expect(routePermissions("/daily-updates/:date", "put")).toEqual([
      WORKSPACE_PERMISSION.PLANNING_SUBMIT,
    ]);
    expect(routePermissions("/weekly-plans/:weekStart", "put")).toEqual([
      WORKSPACE_PERMISSION.PLANNING_SUBMIT,
    ]);
    expect(routePermissions("/monthly-priorities/:month", "put")).toEqual([
      WORKSPACE_PERMISSION.PLANNING_MANAGE,
    ]);
    expect(routePermissions("/daily-updates/:id/attention", "patch")).toEqual([
      WORKSPACE_PERMISSION.PLANNING_MANAGE,
    ]);
  });

  it("allows submit, team-view, or manage roles to load the workspace", () => {
    expect(routePermissions("/overview", "get")).toEqual([
      WORKSPACE_PERMISSION.PLANNING_SUBMIT,
      WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW,
      WORKSPACE_PERMISSION.PLANNING_MANAGE,
    ]);
  });
});

