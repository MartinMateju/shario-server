import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionModel: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
  rowModel: { aggregate: vi.fn() },
  userModel: {},
  tenantMembershipModel: {},
  refreshAvailability: vi.fn(),
}));

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["sort", "skip", "limit", "select"])
    chain[method] = vi.fn(() => chain);
  chain.lean = vi.fn(async () => value);
  chain.then = (
    resolve: (result: T) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
};

vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: mocks.tenantMembershipModel,
}));
vi.mock("@/modules/user/user.model.js", () => ({ default: mocks.userModel }));
vi.mock("../../../src/modules/data-import/data-import-row.model.js", () => ({
  default: mocks.rowModel,
}));
vi.mock(
  "../../../src/modules/data-import/data-import-session.model.js",
  () => ({
    default: mocks.sessionModel,
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-rollback-availability.service.js",
  () => ({ refreshImportRollbackAvailability: mocks.refreshAvailability }),
);
vi.mock(
  "../../../src/modules/data-import/adapters/customer-import.adapter.js",
  () => ({
    isProtectedWorkspaceUser: vi.fn(),
    normalizeCustomerImportRow: vi.fn(),
    normalizeImportPhone: vi.fn((value: string) => value),
    validateCustomerImportRow: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/import-column-mapping.service.js",
  () => ({
    assertValidCustomerColumnMapping: vi.fn(),
    suggestBookingColumnMapping: vi.fn(),
    suggestCreditColumnMapping: vi.fn(),
    suggestCustomerColumnMapping: vi.fn(),
    suggestMembershipColumnMapping: vi.fn(),
    suggestMembershipPlanColumnMapping: vi.fn(),
    suggestProductColumnMapping: vi.fn(),
    suggestVoucherColumnMapping: vi.fn(),
    suggestVoucherProductColumnMapping: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/import-file-parser.service.js",
  () => ({ getImportFileType: vi.fn(), parseImportFile: vi.fn() }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-audit.service.js",
  () => ({ recordDataImportAudit: vi.fn() }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-rollback-marker.service.js",
  () => ({
    isRolledBackImportRecord: vi.fn(),
    rolledBackImportIssue: vi.fn(),
  }),
);

import {
  DATA_IMPORT_ROLLBACK_STATUS,
  DATA_IMPORT_STATUS,
} from "../../../src/modules/data-import/data-import.constants.js";
import {
  getLiveImportExecutionSummary,
  listTenantImportSessions,
} from "../../../src/modules/data-import/services/data-import.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionModel.find.mockReturnValue(query([]));
  mocks.sessionModel.countDocuments.mockResolvedValue(0);
  mocks.rowModel.aggregate.mockResolvedValue([]);
});

describe("data import history", () => {
  it("reports terminal row counts while an import is still processing", async () => {
    const tenant = "tenant-a";
    const session = "session-a";
    mocks.rowModel.aggregate.mockResolvedValue([
      { _id: "created", count: 17 },
      { _id: "updated", count: 3 },
      { _id: "skipped", count: 2 },
      { _id: "failed", count: 1 },
    ]);

    await expect(
      getLiveImportExecutionSummary({
        _id: session,
        tenant,
        status: DATA_IMPORT_STATUS.PROCESSING,
        summary: { total: 50, valid: 48, created: 0 },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        total: 50,
        valid: 48,
        created: 17,
        updated: 3,
        skipped: 2,
        failed: 1,
      }),
    );
    expect(mocks.rowModel.aggregate).toHaveBeenCalledWith([
      {
        $match: {
          tenant,
          session,
          status: {
            $in: ["created", "updated", "skipped", "failed"],
          },
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
  });

  it("does not query rows for a terminal import summary", async () => {
    const summary = { total: 2, created: 2 };

    await expect(
      getLiveImportExecutionSummary({
        status: DATA_IMPORT_STATUS.COMPLETED,
        summary,
      }),
    ).resolves.toBe(summary);
    expect(mocks.rowModel.aggregate).not.toHaveBeenCalled();
  });

  it("scopes every query to the tenant/entity and applies filters safely", async () => {
    const firstQuery = query([]);
    mocks.sessionModel.find.mockReturnValue(firstQuery);
    mocks.sessionModel.countDocuments.mockResolvedValue(73);

    const result = await listTenantImportSessions({
      tenantId: "tenant-a",
      entityType: "bookings",
      page: 2,
      limit: 200,
      status: DATA_IMPORT_STATUS.COMPLETED,
      rollbackStatus: DATA_IMPORT_ROLLBACK_STATUS.PARTIAL,
      createdFrom: "2026-07-01",
      createdTo: "2026-07-31",
      search: "  July [VIP].csv  ",
    });

    const expectedFilter = {
      tenant: "tenant-a",
      entityType: "bookings",
      status: "completed",
      "rollback.status": "partial",
      createdAt: {
        $gte: new Date("2026-07-01T00:00:00.000Z"),
        $lt: new Date("2026-08-01T00:00:00.000Z"),
      },
      originalFileName: {
        $regex: "July \\[VIP\\]\\.csv",
        $options: "i",
      },
    };
    expect(mocks.sessionModel.find).toHaveBeenCalledWith(expectedFilter);
    expect(mocks.sessionModel.countDocuments).toHaveBeenCalledWith(
      expectedFilter,
    );
    expect(firstQuery.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(firstQuery.skip).toHaveBeenCalledWith(50);
    expect(firstQuery.limit).toHaveBeenCalledWith(50);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 50,
      total: 73,
      totalPages: 2,
    });
  });

  it("uses an inclusive timestamp upper bound but an exclusive next-day date-only bound", async () => {
    await listTenantImportSessions({
      tenantId: "tenant-a",
      createdTo: "2026-07-31T13:14:15.000Z",
    });
    expect(mocks.sessionModel.find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        createdAt: { $lte: new Date("2026-07-31T13:14:15.000Z") },
      }),
    );

    await listTenantImportSessions({
      tenantId: "tenant-a",
      createdTo: "2026-07-31",
    });
    expect(mocks.sessionModel.find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        createdAt: { $lt: new Date("2026-08-01T00:00:00.000Z") },
      }),
    );
  });

  it.each([
    [{ status: "destroyed" }, "IMPORT_STATUS_FILTER_INVALID"],
    [{ rollbackStatus: "deleted" }, "IMPORT_ROLLBACK_STATUS_FILTER_INVALID"],
    [{ createdFrom: "not-a-date" }, "IMPORT_CREATED_FROM_INVALID"],
    [{ createdTo: "not-a-date" }, "IMPORT_CREATED_TO_INVALID"],
    [
      { createdFrom: "2026-08-02", createdTo: "2026-08-01" },
      "IMPORT_DATE_RANGE_INVALID",
    ],
  ] as const)("rejects invalid history filters %#", async (input, code) => {
    await expect(
      listTenantImportSessions({ tenantId: "tenant-a", ...input }),
    ).rejects.toMatchObject({ code });
    expect(mocks.sessionModel.find).not.toHaveBeenCalled();
  });

  it("refreshes only stale sessions already returned by the tenant-scoped page", async () => {
    const stale = {
      _id: "session-a",
      tenant: "tenant-a",
      entityType: "customers",
      status: "completed",
      rollback: { status: "unavailable" },
    };
    const ready = {
      ...stale,
      _id: "session-b",
      rollback: { status: "available", revision: 1 },
    };
    const refreshed = {
      ...stale,
      rollback: { status: "available", revision: 1 },
    };
    mocks.sessionModel.find
      .mockReturnValueOnce(query([stale, ready]))
      .mockReturnValueOnce(query([refreshed, ready]));
    mocks.sessionModel.countDocuments.mockResolvedValue(2);

    const result = await listTenantImportSessions({ tenantId: "tenant-a" });

    expect(mocks.refreshAvailability).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAvailability).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      sessionId: "session-a",
    });
    expect(mocks.sessionModel.find).toHaveBeenLastCalledWith({
      tenant: "tenant-a",
      _id: { $in: ["session-a", "session-b"] },
    });
    expect(result.items.map((item: any) => item.rollback.status)).toEqual([
      "available",
      "available",
    ]);
  });

  it("truncates search input before escaping it", async () => {
    await listTenantImportSessions({
      tenantId: "tenant-a",
      search: "*".repeat(150),
    });
    const filter = mocks.sessionModel.find.mock.calls[0][0];
    expect(filter.originalFileName.$regex).toBe("\\*".repeat(100));
  });
});
