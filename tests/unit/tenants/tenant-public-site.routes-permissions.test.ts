import { describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  const verifyJWT = vi.fn((_req, _res, next) => next());
  const requirePermission = vi.fn((...permissions: string[]) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermissions: permissions });
    return middleware;
  });
  const mediaUpload = vi.fn((_req, _res, next) => next());
  Object.assign(mediaUpload, { publicSiteMediaUpload: true });
  return {
    verifyJWT,
    requirePermission,
    mediaUpload,
    handler: vi.fn(),
  };
});

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: routeMocks.verifyJWT,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: routeMocks.requirePermission,
}));
vi.mock("@/modules/tenants/settings/tenant-settings.controller.js", () => ({
  getCurrentTenantPublicSite: routeMocks.handler,
  getCurrentTenantPublicSitePreview: routeMocks.handler,
  getCurrentTenantPublicSiteVersions: routeMocks.handler,
  getCurrentTenantSettings: routeMocks.handler,
  getCurrentTenantWorkspaceConfiguration: routeMocks.handler,
  publishCurrentTenantPublicSite: routeMocks.handler,
  resetCurrentTenantPublicSiteDraft: routeMocks.handler,
  restoreCurrentTenantPublicSiteVersion: routeMocks.handler,
  uploadCurrentTenantPublicSiteMedia: routeMocks.handler,
  updateCurrentTenantPublicSite: routeMocks.handler,
  updateCurrentTenantSettings: routeMocks.handler,
  updateCurrentTenantWorkspaceConfiguration: routeMocks.handler,
}));
vi.mock("@/modules/tenants/settings/public-site-media.middleware.js", () => ({
  publicSiteMediaUpload: routeMocks.mediaUpload,
}));

import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { tenantSettingsRouter } from "@/modules/tenants/settings/tenant-settings.routes.js";

type RouterLayer = {
  handle: {
    publicSiteMediaUpload?: boolean;
    workspacePermissions?: string[];
  };
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: {
        publicSiteMediaUpload?: boolean;
        workspacePermissions?: string[];
      };
    }>;
  };
};

const stack = tenantSettingsRouter.stack as unknown as RouterLayer[];

const permissionsFor = (path: string, method: string): string[][] => {
  const layer = stack.find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method] === true,
  );
  expect(layer).toBeDefined();
  return layer!
    .route!.stack.map(({ handle }) => handle.workspacePermissions)
    .filter((value): value is string[] => Boolean(value));
};

describe("tenant public-site settings route authorization", () => {
  it("authenticates before public-site settings routes", () => {
    expect(stack[0]?.handle).toBe(routeMocks.verifyJWT);
  });

  it("requires workspace view permission to read settings", () => {
    expect(permissionsFor("/public-site", "get")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_VIEW],
    ]);
  });

  it("protects workspace profile reads and repairs with view/update permissions", () => {
    expect(permissionsFor("/", "get")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_VIEW],
    ]);
    expect(permissionsFor("/", "patch")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_UPDATE],
    ]);
  });

  it("keeps draft preview behind workspace view permission", () => {
    expect(permissionsFor("/public-site/preview", "get")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_VIEW],
    ]);
  });

  it("keeps version metadata behind workspace view permission", () => {
    expect(permissionsFor("/public-site/versions", "get")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_VIEW],
    ]);
  });

  it("reserves workspace configuration reads and writes for owners", () => {
    expect(permissionsFor("/workspace-configuration", "get")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_CONFIGURATION_MANAGE],
    ]);
    expect(permissionsFor("/workspace-configuration", "patch")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_CONFIGURATION_MANAGE],
    ]);
  });

  it("requires workspace update permission to change settings", () => {
    expect(permissionsFor("/public-site", "patch")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_UPDATE],
    ]);
  });

  it("reserves publishing for the workspace publish permission", () => {
    expect(permissionsFor("/public-site/publish", "post")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_PUBLISH],
    ]);
  });

  it("requires workspace update permission to reset a draft", () => {
    expect(permissionsFor("/public-site/reset-draft", "post")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_UPDATE],
    ]);
  });

  it("requires workspace update permission to restore a version", () => {
    expect(
      permissionsFor("/public-site/versions/:versionId/restore", "post"),
    ).toEqual([[WORKSPACE_PERMISSION.WORKSPACE_UPDATE]]);
  });

  it("requires workspace update permission before processing media", () => {
    expect(permissionsFor("/public-site/media/:slot", "post")).toEqual([
      [WORKSPACE_PERMISSION.WORKSPACE_UPDATE],
    ]);

    const layer = stack.find(
      (candidate) =>
        candidate.route?.path === "/public-site/media/:slot" &&
        candidate.route.methods.post === true,
    );
    const permissionIndex = layer!.route!.stack.findIndex(
      ({ handle }) =>
        handle.workspacePermissions?.[0] ===
        WORKSPACE_PERMISSION.WORKSPACE_UPDATE,
    );
    const uploadIndex = layer!.route!.stack.findIndex(
      ({ handle }) => handle.publicSiteMediaUpload === true,
    );
    expect(permissionIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(permissionIndex);
  });
});
