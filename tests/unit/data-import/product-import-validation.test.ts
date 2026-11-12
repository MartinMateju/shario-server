import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantImportSession: vi.fn(),
  serializeImportSession: vi.fn((value: unknown) => value),
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowBulkWrite: vi.fn(),
  productFind: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  createDataImportSession: vi.fn(),
  getTenantImportSession: mocks.getTenantImportSession,
  serializeImportSession: mocks.serializeImportSession,
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
    bulkWrite: mocks.rowBulkWrite,
  },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { find: mocks.productFind },
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));

import { validateProductImportSession } from "@/modules/data-import/services/product-import.service.js";

const current = {
  _id: "session-1",
  entityType: "products",
  status: "uploaded",
  headers: ["Name", "Kind", "External ID", "SKU", "Capacity"],
  fileHash: "a".repeat(64),
};

const sessionQuery = (value: unknown) => ({
  lean: () => Promise.resolve(value),
});

const rowQuery = (value: unknown) => ({
  sort: () => ({ lean: () => Promise.resolve(value) }),
});

const selectLean = (value: unknown) => ({
  select: vi.fn(() => ({ lean: () => Promise.resolve(value) })),
});

const issueCodes = (operation: any): string[] =>
  operation.updateOne.update.$set.issues.map((issue: any) => issue.code);

const runValidation = async ({
  rows,
  products,
  mapping,
  duplicateStrategy = "skip",
}: {
  rows: any[];
  products: any[];
  mapping: Record<string, string>;
  duplicateStrategy?: "skip" | "update";
}) => {
  mocks.rowFind.mockReturnValue(rowQuery(rows));
  mocks.productFind.mockReturnValue(selectLean(products));
  await validateProductImportSession({
    tenantId: "tenant-1",
    sessionId: "session-1",
    mapping,
    duplicateStrategy,
    actorId: "actor-1",
    tenantCurrency: "CZK",
    enabledModules: new Set(["bookings", "courses"]),
  });
  return mocks.rowBulkWrite.mock.calls[0][0] as any[];
};

describe("product import validation duplicate semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantImportSession.mockResolvedValue(current);
    mocks.sessionFindOneAndUpdate
      .mockReturnValueOnce(sessionQuery(current))
      .mockReturnValueOnce(
        sessionQuery({
          ...current,
          status: "validated",
          validationRevision: "r",
        }),
      );
    mocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 1 });
    mocks.recordAudit.mockResolvedValue({});
  });

  it("loads archive state and marks an archived product update invalid before execution", async () => {
    const operations = await runValidation({
      rows: [{ _id: "row-2", rowNumber: 2, raw: { Name: "Old studio", Kind: "Open Studio" } }],
      products: [{ _id: "old", name: "Old studio", kind: "open-studio", type: "workshop", bookingMode: "public", isActive: false, isArchived: true }],
      mapping: { name: "Name", kind: "Kind" }, duplicateStrategy: "update",
    });
    expect(mocks.productFind.mock.results[0].value.select).toHaveBeenCalledWith(expect.stringContaining("isArchived"));
    expect(operations[0].updateOne.update.$set.status).toBe("invalid");
    expect(issueCodes(operations[0])).toContain("PRODUCT_ARCHIVED");
  });

  it("marks conflicting external ID and name matches invalid", async () => {
    const operations = await runValidation({
      rows: [
        {
          _id: "row-2",
          rowNumber: 2,
          raw: {
            Name: "Uploaded Class",
            Kind: "Class",
            "External ID": "legacy-1",
            Capacity: "8",
          },
        },
      ],
      products: [
        {
          _id: "product-a",
          name: "Different Class",
          kind: "class",
          type: "course",
          importMetadata: { externalId: "legacy-1" },
        },
        {
          _id: "product-b",
          name: "Uploaded Class",
          kind: "class",
          type: "course",
        },
      ],
      mapping: {
        name: "Name",
        kind: "Kind",
        externalId: "External ID",
        capacity: "Capacity",
      },
    });

    expect(operations[0].updateOne.update.$set.status).toBe("invalid");
    expect(issueCodes(operations[0])).toContain("PRODUCT_IDENTITY_CONFLICT");
  });

  it("rejects an update that would change a legacy product kind", async () => {
    const operations = await runValidation({
      rows: [
        {
          _id: "row-2",
          rowNumber: 2,
          raw: { Name: "Legacy Course", Kind: "Open Studio" },
        },
      ],
      products: [
        {
          _id: "product-1",
          name: "Legacy Course",
          type: "course",
          price: 500,
          extraCharge: 0,
          currency: "CZK",
          maxNumberOfParticipants: 8,
          isActive: true,
        },
      ],
      mapping: { name: "Name", kind: "Kind" },
      duplicateStrategy: "update",
    });

    expect(operations[0].updateOne.update.$set.status).toBe("invalid");
    expect(issueCodes(operations[0])).toContain(
      "PRODUCT_KIND_UPDATE_FORBIDDEN",
    );
  });

  it("rejects a product kind mismatch even under the default skip strategy", async () => {
    const operations = await runValidation({
      rows: [
        {
          _id: "row-2",
          rowNumber: 2,
          raw: { Name: "Legacy Course", Kind: "Open Studio" },
        },
      ],
      products: [
        {
          _id: "product-1",
          name: "Legacy Course",
          type: "course",
          price: 500,
          extraCharge: 0,
          currency: "CZK",
          maxNumberOfParticipants: 8,
          isActive: true,
        },
      ],
      mapping: { name: "Name", kind: "Kind" },
      duplicateStrategy: "skip",
    });

    expect(operations[0].updateOne.update.$set.status).toBe("invalid");
    expect(issueCodes(operations[0])).toContain(
      "PRODUCT_KIND_UPDATE_FORBIDDEN",
    );
  });

  it("does not let an invalid earlier row poison a valid database duplicate", async () => {
    const operations = await runValidation({
      rows: [
        {
          _id: "row-2",
          rowNumber: 2,
          raw: { Name: "Shared Studio", Kind: "Class" },
        },
        {
          _id: "row-3",
          rowNumber: 3,
          raw: { Name: "Shared Studio", Kind: "Open Studio" },
        },
      ],
      products: [
        {
          _id: "product-1",
          name: "Shared Studio",
          kind: "open-studio",
          type: "workshop",
          bookingMode: "public",
          price: 300,
          extraCharge: 0,
          currency: "CZK",
          maxNumberOfParticipants: 8,
          studioFlow: {
            registrationPolicy: "optional",
            firingBilling: "included",
          },
          isActive: true,
          sortOrder: 1,
        },
      ],
      mapping: { name: "Name", kind: "Kind" },
      duplicateStrategy: "update",
    });

    expect(operations[0].updateOne.update.$set.status).toBe("invalid");
    expect(issueCodes(operations[0])).toContain(
      "PRODUCT_KIND_UPDATE_FORBIDDEN",
    );

    const second = operations[1].updateOne.update.$set;
    expect(second.status).toBe("valid");
    expect(second.duplicate).toMatchObject({
      kind: "name",
      existingRecordId: "product-1",
    });
    expect(issueCodes(operations[1])).not.toContain(
      "PRODUCT_DUPLICATE_IN_FILE",
    );

    const finalSessionUpdate = mocks.sessionFindOneAndUpdate.mock.calls[1][1];
    expect(finalSessionUpdate.$set.summary).toMatchObject({
      valid: 1,
      invalid: 1,
      toUpdate: 1,
    });
  });

  it("can skip an existing active product when capacity was omitted", async () => {
    const operations = await runValidation({
      rows: [
        {
          _id: "row-2",
          rowNumber: 2,
          raw: { Name: "Shared Studio", Kind: "Open Studio" },
        },
      ],
      products: [
        {
          _id: "product-1",
          name: "Shared Studio",
          kind: "open-studio",
          type: "workshop",
          bookingMode: "public",
          price: 300,
          extraCharge: 0,
          currency: "CZK",
          maxNumberOfParticipants: 8,
          studioFlow: {
            registrationPolicy: "optional",
            firingBilling: "included",
          },
          isActive: true,
          sortOrder: 1,
        },
      ],
      mapping: { name: "Name", kind: "Kind" },
    });

    const result = operations[0].updateOne.update.$set;
    expect(result.status).toBe("valid");
    expect(result.issues).toEqual([]);
    expect(result.duplicate).toMatchObject({
      kind: "name",
      existingRecordId: "product-1",
    });
    expect(result.normalized.capacity).toBeNull();

    const finalSessionUpdate = mocks.sessionFindOneAndUpdate.mock.calls[1][1];
    expect(finalSessionUpdate.$set.summary).toMatchObject({
      valid: 1,
      invalid: 0,
      duplicates: 1,
      toSkip: 1,
    });
  });
});
