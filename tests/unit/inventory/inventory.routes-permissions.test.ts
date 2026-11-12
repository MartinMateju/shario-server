import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  requirePermission: vi.fn((permission: string) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermission: permission });
    return middleware;
  }),
  handler: vi.fn(),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: routeMocks.handler,
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: routeMocks.requirePermission,
}));

vi.mock("@/modules/inventory/controllers/inventory.controller.js", () => ({
  completeInventoryAudit: routeMocks.handler,
  createInventoryAudit: routeMocks.handler,
  createInventoryItem: routeMocks.handler,
  createInventoryMovement: routeMocks.handler,
  createReorderRequest: routeMocks.handler,
  getInventoryAudits: routeMocks.handler,
  getInventoryItem: routeMocks.handler,
  getInventoryItems: routeMocks.handler,
  getInventoryMovements: routeMocks.handler,
  getReorderRequests: routeMocks.handler,
  receiveReorderRequest: routeMocks.handler,
  updateInventoryAudit: routeMocks.handler,
  updateInventoryItem: routeMocks.handler,
  updateReorderRequest: routeMocks.handler,
}));

import inventoryRouter from "@/modules/inventory/routes/inventory.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: { workspacePermission?: string };
    }>;
  };
};

const permissionFor = (path: string, method: string): string[] => {
  const layer = (inventoryRouter.stack as unknown as RouterLayer[]).find(
    (candidate) =>
      candidate.route?.path === path && candidate.route.methods[method],
  );
  expect(layer, `${method.toUpperCase()} ${path} must exist`).toBeDefined();

  return (
    layer?.route?.stack
      .map(({ handle }) => handle.workspacePermission)
      .filter((value): value is string => Boolean(value)) ?? []
  );
};

describe("inventory route authorization", () => {
  it.each([
    ["/items", "get"],
    ["/items/:id", "get"],
    ["/movements", "get"],
    ["/audits", "get"],
    ["/reorders", "get"],
  ] as const)("requires inventory view for %s %s", (path, method) => {
    expect(permissionFor(path, method)).toContain(
      WORKSPACE_PERMISSION.INVENTORY_VIEW,
    );
  });

  it.each([
    ["/items", "post"],
    ["/items/:id", "patch"],
    ["/movements", "post"],
    ["/audits", "post"],
    ["/audits/:id", "patch"],
    ["/audits/:id/complete", "patch"],
    ["/reorders", "post"],
    ["/reorders/:id", "patch"],
    ["/reorders/:id/receive", "patch"],
  ] as const)("requires inventory management for %s %s", (path, method) => {
    expect(permissionFor(path, method)).toContain(
      WORKSPACE_PERMISSION.INVENTORY_MANAGE,
    );
  });

  it("gates inventory and supplier routes by the inventory tenant module", () => {
    const appRoutes = readFileSync(
      new URL("../../../src/app/routes.ts", import.meta.url),
      "utf8",
    );
    const supplyRoutes = readFileSync(
      new URL(
        "../../../src/modules/supplies/routes/supply-order.routes.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(appRoutes).toMatch(
      /apiRouter\.use\(\s*"\/inventory"\s*,\s*requireWorkspaceSession\s*,\s*inventoryModule\s*,\s*inventoryRoutes\s*,?\s*\)/,
    );
    expect(supplyRoutes).toContain(
      'router.use("/suppliers", inventoryModule);',
    );
  });
});
