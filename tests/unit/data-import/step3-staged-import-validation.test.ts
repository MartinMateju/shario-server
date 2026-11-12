import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  serializeSession: vi.fn(),
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowBulkWrite: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/modules/data-import/data-import-session.model.js", () => ({
  default: {
    findOneAndUpdate: mocks.sessionFindOneAndUpdate,
    updateOne: mocks.sessionUpdateOne,
  },
}));
vi.mock("@/modules/data-import/data-import-row.model.js", () => ({
  default: { find: mocks.rowFind, bulkWrite: mocks.rowBulkWrite },
}));
vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  getTenantImportSession: mocks.getSession,
  serializeImportSession: mocks.serializeSession,
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));

import { validateStagedImportSession } from "@/modules/data-import/services/staged-import-validation.service.js";

const current = {
  _id: "session-object-id",
  tenant: "tenant-1",
  entityType: "credits",
  status: "uploaded",
  headers: ["Customer", "Balance"],
};

const leanResult = (value: unknown) => ({
  lean: () => Promise.resolve(value),
});

describe("shared Step 3 staged validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(current);
    mocks.serializeSession.mockImplementation((value) => value);
    mocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 2 });
    mocks.recordAudit.mockResolvedValue({});
  });

  it("rejects bad mappings before taking the validation claim", async () => {
    const mappingError = Object.assign(new Error("mapping invalid"), {
      code: "IMPORT_MAPPING_CREDIT_REQUIRED",
    });
    const assertMapping = vi.fn(() => {
      throw mappingError;
    });

    await expect(
      validateStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        mappingInput: {},
        duplicateStrategy: "skip",
        actorId: "actor-1",
        assertMapping,
        prepare: vi.fn(),
      }),
    ).rejects.toBe(mappingError);

    expect(assertMapping).toHaveBeenCalledWith(current.headers, {});
    expect(mocks.sessionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.rowFind).not.toHaveBeenCalled();
  });

  it("does not reclaim an import another validator already claimed", async () => {
    mocks.getSession.mockResolvedValue({ ...current, status: "validating" });
    const assertMapping = vi.fn();
    const prepare = vi.fn();

    await expect(
      validateStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        mappingInput: {},
        duplicateStrategy: "skip",
        actorId: "actor-1",
        assertMapping,
        prepare,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_INVALID" });

    expect(assertMapping).not.toHaveBeenCalled();
    expect(mocks.sessionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.rowFind).not.toHaveBeenCalled();
    expect(mocks.rowBulkWrite).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("claims, prepares, summarizes, and persists every staged row", async () => {
    const rows = [
      { _id: "row-2", rowNumber: 2 },
      { _id: "row-3", rowNumber: 3 },
    ];
    const validated = {
      ...current,
      status: "validated",
      summary: { valid: 1, invalid: 1 },
    };
    mocks.sessionFindOneAndUpdate
      .mockReturnValueOnce(leanResult({ ...current, status: "validating" }))
      .mockReturnValueOnce(leanResult(validated));
    mocks.rowFind.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(rows) }),
    });
    const prepare = vi.fn().mockResolvedValue([
      {
        normalized: { customerId: "customer-1", balanceMinor: 1000 },
        issues: [
          {
            code: "CREDIT_DUPLICATE",
            severity: "warning",
            message: "Existing allocation.",
          },
        ],
        duplicate: { kind: "externalId", existingRecordId: "allocation-1" },
      },
      {
        normalized: { balanceMinor: null },
        issues: [
          {
            code: "CREDIT_CUSTOMER_NOT_FOUND",
            severity: "error",
            message: "Customer not found.",
          },
        ],
        duplicate: null,
      },
    ]);

    const result = await validateStagedImportSession({
      tenantId: "tenant-1",
      sessionId: "session-1",
      entityType: "credits",
      mappingInput: { customerEmail: "Customer", balance: "Balance" },
      duplicateStrategy: "update",
      actorId: "actor-1",
      validationContext: { tenantCurrency: "CZK" },
      assertMapping: (_headers, value) => value as Record<string, string>,
      prepare,
    });

    expect(prepare).toHaveBeenCalledWith({
      rows,
      mapping: { customerEmail: "Customer", balance: "Balance" },
    });
    expect(mocks.rowBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: {
              _id: "row-2",
              tenant: "tenant-1",
              session: "session-object-id",
            },
            update: {
              $set: expect.objectContaining({
                status: "valid",
                duplicate: expect.objectContaining({
                  kind: "externalId",
                  existingRecordId: "allocation-1",
                }),
              }),
            },
          }),
        }),
        expect.objectContaining({
          updateOne: expect.objectContaining({
            update: {
              $set: expect.objectContaining({ status: "invalid" }),
            },
          }),
        }),
      ],
      { ordered: true },
    );
    const finalUpdate = mocks.sessionFindOneAndUpdate.mock.calls[1];
    expect(finalUpdate[0]).toMatchObject({
      _id: "session-object-id",
      tenant: "tenant-1",
      entityType: "credits",
      status: "validating",
    });
    expect(finalUpdate[1].$set).toMatchObject({
      status: "validated",
      duplicateStrategy: "update",
      summary: {
        total: 2,
        valid: 1,
        warnings: 1,
        invalid: 1,
        duplicates: 1,
        toCreate: 0,
        toUpdate: 1,
        toSkip: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      },
    });
    expect(finalUpdate[1].$set.validationRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.validationRevision).toBe(
      finalUpdate[1].$set.validationRevision,
    );
  });

  it("marks a claimed session retryable-failed when preparation crashes", async () => {
    mocks.sessionFindOneAndUpdate.mockReturnValue(
      leanResult({ ...current, status: "validating" }),
    );
    mocks.rowFind.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve([{ _id: "row-2" }]) }),
    });
    const failure = new Error("domain lookup unavailable");

    await expect(
      validateStagedImportSession({
        tenantId: "tenant-1",
        sessionId: "session-1",
        entityType: "credits",
        mappingInput: { customerEmail: "Customer", balance: "Balance" },
        duplicateStrategy: "skip",
        actorId: "actor-1",
        assertMapping: (_headers, value) => value as Record<string, string>,
        prepare: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);

    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      {
        _id: "session-object-id",
        tenant: "tenant-1",
        status: "validating",
      },
      {
        $set: {
          status: "failed",
          lastError: {
            code: "IMPORT_VALIDATION_FAILED",
            message: "domain lookup unavailable",
          },
        },
      },
    );
  });
});
