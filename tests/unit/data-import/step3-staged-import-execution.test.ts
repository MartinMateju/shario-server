import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowFindOneAndUpdate: vi.fn(),
  rowUpdateOne: vi.fn(),
  rowCountDocuments: vi.fn(),
  recordAudit: vi.fn(),
  assertReady: vi.fn(),
  completeImport: vi.fn(),
  mutationFindOne: vi.fn(),
}));

vi.mock("@/modules/data-import/data-import-session.model.js", () => ({
  default: {
    findOneAndUpdate: mocks.sessionFindOneAndUpdate,
    updateOne: mocks.sessionUpdateOne,
  },
}));
vi.mock("@/modules/data-import/data-import-row.model.js", () => ({
  default: {
    find: mocks.rowFind,
    findOneAndUpdate: mocks.rowFindOneAndUpdate,
    updateOne: mocks.rowUpdateOne,
    countDocuments: mocks.rowCountDocuments,
  },
}));
vi.mock("@/modules/data-import/data-import-mutation.model.js", () => ({
  default: { findOne: mocks.mutationFindOne },
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));
vi.mock(
  "@/modules/data-import/services/commerce-import-readiness.service.js",
  () => ({ assertCommerceImportReady: mocks.assertReady }),
);

vi.mock(
  "@/modules/data-import/services/data-import-rollback-availability.service.js",
  () => ({ completeImportWithRollbackAvailability: mocks.completeImport }),
);

import { processStagedImportSession } from "@/modules/data-import/services/staged-import-execution.service.js";

const claimedSession = {
  _id: "session-object-id",
  tenant: "tenant-1",
  entityType: "credits",
  queuedBy: "queued-actor",
  createdBy: "upload-actor",
  claimToken: "generated-at-runtime",
};

const claimResult = (value: unknown) => ({
  select: () => ({ lean: () => Promise.resolve(value) }),
});

const configureRows = (rows: Array<any>) => {
  mocks.rowFind.mockReturnValue({ sort: () => Promise.resolve(rows) });
  mocks.rowFindOneAndUpdate.mockImplementation(({ _id }) =>
    Promise.resolve(rows.find((row) => row._id === _id) ?? null),
  );
};

describe("shared Step 3 staged execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionFindOneAndUpdate.mockReturnValue(claimResult(claimedSession));
    mocks.sessionUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mocks.rowUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(
        ({ created: 1, updated: 0, skipped: 1, failed: 0 } as any)[status] ?? 0,
      ),
    );
    mocks.recordAudit.mockResolvedValue({});
    mocks.assertReady.mockResolvedValue(undefined);
    mocks.completeImport.mockResolvedValue(undefined);
    mocks.mutationFindOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });
  });

  it("allows only one worker to claim a queued session", async () => {
    mocks.sessionFindOneAndUpdate.mockReturnValue(claimResult(null));
    const executeRow = vi.fn();

    await expect(
      processStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        executeRow,
      }),
    ).resolves.toEqual({ skipped: true, reason: "not_claimable" });

    expect(mocks.rowFind).not.toHaveBeenCalled();
    expect(executeRow).not.toHaveBeenCalled();
  });

  it("skips file duplicates and executes each claimed row once", async () => {
    const rows = [
      {
        _id: "row-2",
        rowNumber: 2,
        duplicate: { kind: "file", rowNumber: 1 },
      },
      { _id: "row-3", rowNumber: 3, duplicate: null },
    ];
    configureRows(rows);
    const executeRow = vi.fn().mockResolvedValue({
      action: "created",
      recordId: "allocation-1",
      message: "Opening allocation created.",
    });

    await expect(
      processStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        executeRow,
      }),
    ).resolves.toEqual({ created: 1, updated: 0, skipped: 1, failed: 0 });

    expect(executeRow).toHaveBeenCalledTimes(1);
    expect(executeRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        sessionId: "session-1",
        actorId: "queued-actor",
        row: rows[1],
      }),
    );
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2", tenant: "tenant-1", session: "session-object-id" },
      {
        $set: {
          status: "skipped",
          resultRecord: null,
          resultMessage: "Duplicate row in the uploaded file.",
        },
      },
    );
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-3", tenant: "tenant-1", session: "session-object-id" },
      {
        $set: {
          status: "created",
          resultRecord: "allocation-1",
          resultMessage: "Opening allocation created.",
        },
      },
    );
    expect(mocks.completeImport).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sessionId: "session-1",
      claimToken: expect.any(String),
      summary: {
        created: 1,
        updated: 0,
        skipped: 1,
        failed: 0,
      },
    });
  });

  it("isolates a row failure and still completes the session report", async () => {
    const rows = [{ _id: "row-2", rowNumber: 2, duplicate: null }];
    configureRows(rows);
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(status === "failed" ? 1 : 0),
    );
    const executeRow = vi
      .fn()
      .mockRejectedValue(new Error("live balance changed"));

    await expect(
      processStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        executeRow,
      }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2", tenant: "tenant-1", session: "session-object-id" },
      {
        $set: {
          status: "failed",
          resultRecord: null,
          resultMessage: "live balance changed",
        },
      },
    );
  });

  it("stops before row execution when the lease heartbeat is lost", async () => {
    configureRows([{ _id: "row-2", rowNumber: 2, duplicate: null }]);
    mocks.sessionUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const executeRow = vi.fn();

    await expect(
      processStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        executeRow,
      }),
    ).rejects.toThrow("Import execution lease was lost.");

    expect(executeRow).not.toHaveBeenCalled();
    expect(mocks.rowFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("durably fails a claimed session when commerce indexes are not ready", async () => {
    const error = Object.assign(
      new Error("Commerce import indexes are not ready."),
      { code: "IMPORT_COMMERCE_INDEXES_NOT_READY", statusCode: 503 },
    );
    mocks.assertReady.mockRejectedValue(error);
    const executeRow = vi.fn();

    await expect(
      processStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        executeRow,
      }),
    ).rejects.toBe(error);

    expect(mocks.assertReady).toHaveBeenCalledWith("credits");
    expect(mocks.rowFind).not.toHaveBeenCalled();
    expect(mocks.rowFindOneAndUpdate).not.toHaveBeenCalled();
    expect(executeRow).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      {
        _id: "session-object-id",
        tenant: "tenant-1",
        claimToken: expect.any(String),
      },
      {
        $set: {
          status: "failed",
          leaseExpiresAt: null,
          claimToken: null,
          lastError: {
            code: "IMPORT_COMMERCE_INDEXES_NOT_READY",
            message: "Commerce import indexes are not ready.",
          },
        },
      },
    );
  });
});
