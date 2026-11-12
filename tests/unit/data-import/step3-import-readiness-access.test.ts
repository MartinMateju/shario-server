import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertReady: vi.fn(),
  getSession: vi.fn(),
  requireModule: vi.fn(),
  requireAnyModule: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/commerce-import-readiness.service.js",
  () => ({ assertCommerceImportReady: mocks.assertReady }),
);
vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  getTenantImportSession: mocks.getSession,
}));
vi.mock("@/modules/tenants/middleware/requireTenantModule.js", () => ({
  requireTenantModule: mocks.requireModule,
  requireAnyTenantModule: mocks.requireAnyModule,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: () => "tenant-1",
}));

import {
  requireImportSessionAccess,
  requireStaticImportAccess,
} from "@/modules/data-import/data-import-access.middleware.js";
import { DATA_IMPORT_ENTITY } from "@/modules/data-import/data-import.constants.js";

describe("Step 3 commerce import readiness access gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertReady.mockResolvedValue(undefined);
    mocks.requireModule.mockImplementation(
      () => (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
        next(),
    );
    mocks.requireAnyModule.mockImplementation(
      () => (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
        next(),
    );
    mocks.requirePermission.mockImplementation(
      () => (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
        next(),
    );
  });

  it.each([
    DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
    DATA_IMPORT_ENTITY.MEMBERSHIPS,
    DATA_IMPORT_ENTITY.CREDITS,
    DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS,
    DATA_IMPORT_ENTITY.VOUCHERS,
  ])("checks readiness before static %s access", async (entityType) => {
    const next = vi.fn();

    await requireStaticImportAccess(entityType)({} as never, {} as never, next);

    expect(mocks.assertReady).toHaveBeenCalledWith(entityType);
    expect(mocks.requireModule).toHaveBeenCalledTimes(1);
    expect(mocks.requirePermission).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    ["disabled", "IMPORT_COMMERCE_NOT_ENABLED"],
    ["indexes not ready", "IMPORT_COMMERCE_INDEXES_NOT_READY"],
  ])(
    "returns a 503 error before module/permission checks when commerce is %s",
    async (_state, code) => {
      const error = Object.assign(new Error("Commerce import unavailable."), {
        statusCode: 503,
        code,
      });
      mocks.assertReady.mockRejectedValue(error);
      const next = vi.fn();

      await requireStaticImportAccess(DATA_IMPORT_ENTITY.CREDITS)(
        {} as never,
        {} as never,
        next,
      );

      expect(next).toHaveBeenCalledWith(error);
      expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 503, code });
      expect(mocks.requireModule).not.toHaveBeenCalled();
      expect(mocks.requireAnyModule).not.toHaveBeenCalled();
      expect(mocks.requirePermission).not.toHaveBeenCalled();
    },
  );

  it("checks readiness against the stored session entity before session access", async () => {
    mocks.getSession.mockResolvedValue({
      _id: "session-1",
      entityType: DATA_IMPORT_ENTITY.VOUCHERS,
    });
    const req: any = { params: { id: "session-1" } };
    const next = vi.fn();

    await requireImportSessionAccess(req, {} as never, next);

    expect(mocks.assertReady).toHaveBeenCalledWith(DATA_IMPORT_ENTITY.VOUCHERS);
    expect(req.dataImportSession).toMatchObject({ entityType: "vouchers" });
    expect(mocks.requireModule).toHaveBeenCalledTimes(1);
    expect(mocks.requirePermission).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});
