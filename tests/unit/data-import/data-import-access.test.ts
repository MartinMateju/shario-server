import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permissionCalls: [] as string[][],
  moduleCalls: [] as string[][],
  requirePermission: vi.fn(),
  requireTenantModule: vi.fn(),
  requireAnyTenantModule: vi.fn(),
  requireTenantId: vi.fn(),
  getSession: vi.fn(),
  assertCommerceReady: vi.fn(),
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/tenants/middleware/requireTenantModule.js", () => ({
  requireTenantModule: mocks.requireTenantModule,
  requireAnyTenantModule: mocks.requireAnyTenantModule,
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: mocks.requireTenantId,
}));
vi.mock(
  "../../../src/modules/data-import/services/commerce-import-readiness.service.js",
  () => ({ assertCommerceImportReady: mocks.assertCommerceReady }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import.service.js",
  () => ({
    getTenantImportSession: mocks.getSession,
  }),
);

import {
  requireImportListAccess,
  requireImportRollbackAccess,
  requireImportSessionAccess,
} from "../../../src/modules/data-import/data-import-access.middleware.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissionCalls.length = 0;
  mocks.moduleCalls.length = 0;
  mocks.requireTenantId.mockReturnValue("tenant-a");
  mocks.assertCommerceReady.mockResolvedValue(undefined);
  mocks.requirePermission.mockImplementation((...permissions: string[]) => {
    mocks.permissionCalls.push(permissions);
    return (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
      next();
  });
  mocks.requireTenantModule.mockImplementation((moduleName: string) => {
    mocks.moduleCalls.push([moduleName]);
    return (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
      next();
  });
  mocks.requireAnyTenantModule.mockImplementation((modules: string[]) => {
    mocks.moduleCalls.push([...modules]);
    return (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
      next();
  });
});

const invoke = async (middleware: any, req: Record<string, unknown>) => {
  const next = vi.fn();
  await middleware(req, {}, next);
  expect(next).toHaveBeenCalledWith();
  return req;
};

describe("data import route permission matrix", () => {
  it.each([
    [
      "customers",
      ["customers.import", "data-imports.rollback", "customers.manage"],
      ["customers"],
    ],
    [
      "products",
      ["products.import", "data-imports.rollback", "products.manage"],
      ["bookings", "courses"],
    ],
    [
      "bookings",
      [
        "bookings.import",
        "data-imports.rollback",
        "bookings.cancel",
        "bookings.update",
      ],
      ["bookings"],
    ],
    [
      "membership-plans",
      ["memberships.import", "data-imports.rollback", "memberships.manage"],
      ["memberships"],
    ],
    [
      "memberships",
      ["memberships.import", "data-imports.rollback", "memberships.manage"],
      ["memberships"],
    ],
    [
      "credits",
      ["credits.import", "data-imports.rollback", "credits.manage"],
      ["credits"],
    ],
    [
      "voucher-products",
      ["vouchers.import", "data-imports.rollback", "vouchers.manage"],
      ["vouchers"],
    ],
    [
      "vouchers",
      ["vouchers.import", "data-imports.rollback", "vouchers.manage"],
      ["vouchers"],
    ],
  ] as const)(
    "requires destructive plus entity permissions and modules for %s rollback",
    async (entityType, expectedPermissions, expectedModules) => {
      mocks.getSession.mockResolvedValue({ _id: "session-a", entityType });
      const req = { params: { id: "session-a" }, query: {} } as any;

      await invoke(requireImportRollbackAccess, req);

      expect(mocks.getSession).toHaveBeenCalledWith({
        tenantId: "tenant-a",
        sessionId: "session-a",
      });
      expect(mocks.assertCommerceReady).toHaveBeenCalledWith(entityType);
      expect(mocks.permissionCalls).toEqual([[...expectedPermissions]]);
      expect(mocks.moduleCalls).toEqual([[...expectedModules]]);
      expect(req.dataImportSession).toEqual({ _id: "session-a", entityType });
    },
  );

  it("keeps ordinary import history/report access non-destructive", async () => {
    await invoke(requireImportListAccess, {
      query: { entityType: "credits" },
      params: {},
    });
    expect(mocks.permissionCalls).toEqual([["credits.import"]]);

    mocks.permissionCalls.length = 0;
    mocks.getSession.mockResolvedValue({
      _id: "session-a",
      entityType: "credits",
    });
    await invoke(requireImportSessionAccess, {
      query: {},
      params: { id: "session-a" },
    });
    expect(mocks.permissionCalls).toEqual([["credits.import"]]);
  });

  it("fails before permission middleware when entity input is invalid", async () => {
    const next = vi.fn();
    await requireImportListAccess(
      { query: { entity: "unknown" } } as any,
      {} as any,
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "IMPORT_ENTITY_INVALID" }),
    );
    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(mocks.assertCommerceReady).not.toHaveBeenCalled();
  });

  it("does not invoke permissions when the module/readiness gate fails", async () => {
    const gateError = new Error("indexes missing");
    mocks.assertCommerceReady.mockRejectedValue(gateError);
    const next = vi.fn();

    await requireImportListAccess(
      { query: { entity: "customers" } } as any,
      {} as any,
      next,
    );

    expect(next).toHaveBeenCalledWith(gateError);
    expect(mocks.requirePermission).not.toHaveBeenCalled();
  });
});
