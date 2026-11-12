import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowFindOneAndUpdate: vi.fn(),
  rowUpdateOne: vi.fn(),
  rowCountDocuments: vi.fn(),
  productFind: vi.fn(),
  productFindOne: vi.fn(),
  productCreate: vi.fn(),
  productFindOneAndUpdate: vi.fn(),
  recordAudit: vi.fn(),
  tenantFindOne: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  hasWorkspacePermission: vi.fn(),
  mutationFindOne: vi.fn(),
  recordMutation: vi.fn(),
  completeImport: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
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
vi.mock("@/modules/product/product.model.js", () => ({
  default: {
    find: mocks.productFind,
    findOne: mocks.productFindOne,
    create: mocks.productCreate,
    findOneAndUpdate: mocks.productFindOneAndUpdate,
  },
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));
vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccess,
  hasWorkspacePermission: mocks.hasWorkspacePermission,
}));

vi.mock("@/modules/data-import/data-import-mutation.model.js", () => ({
  default: { findOne: mocks.mutationFindOne },
}));

vi.mock(
  "@/modules/data-import/services/data-import-mutation.service.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/modules/data-import/services/data-import-mutation.service.js")
      >();
    return { ...actual, recordDataImportMutation: mocks.recordMutation };
  },
);

vi.mock(
  "@/modules/data-import/services/data-import-rollback-availability.service.js",
  () => ({ completeImportWithRollbackAvailability: mocks.completeImport }),
);

import { processProductImportSession } from "@/modules/data-import/services/product-import-execution.service.js";

const tenantId = new mongoose.Types.ObjectId().toString();
const sessionId = new mongoose.Types.ObjectId().toString();
const actorId = new mongoose.Types.ObjectId().toString();

const session = (duplicateStrategy = "skip") => ({
  _id: sessionId,
  tenant: tenantId,
  createdBy: actorId,
  fileType: "csv",
  duplicateStrategy,
});

const product = (providedFields: string[] = ["name", "kind"]) => ({
  name: "Shared Studio",
  kind: "open-studio",
  type: "workshop",
  description: "",
  sku: "",
  price: 0,
  extraCharge: 0,
  currency: "CZK",
  capacity: 8,
  bookingMode: "public",
  registrationPolicy: "optional",
  firingBilling: "included",
  isActive: true,
  sortOrder: 0,
  providedFields,
  kindInput: "Open Studio",
  parseErrors: [],
});

const row = (normalized = product()) => ({
  _id: "row-2",
  rowNumber: 2,
  normalized,
  duplicate: null,
});

const selectLean = (value: unknown) => {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.session = vi.fn(() => chain);
  chain.lean = vi.fn(() => Promise.resolve(value));
  return chain;
};

const configureClaim = (value: unknown) => {
  mocks.sessionFindOneAndUpdate.mockReturnValue(selectLean(value));
};

const configureRows = (value: any[]) => {
  mocks.rowFind.mockReturnValue({ sort: () => Promise.resolve(value) });
  mocks.rowFindOneAndUpdate.mockResolvedValue(value[0] || null);
};

describe("product import execution safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureClaim(session());
    configureRows([row()]);
    mocks.tenantFindOne.mockResolvedValue({
      modules: { bookings: true },
      settings: { currency: "CZK" },
    });
    mocks.resolveWorkspaceAccess.mockResolvedValue({ status: "active" });
    mocks.hasWorkspacePermission.mockReturnValue(true);
    (mongoose.connection as any).db = {
      collection: () => ({ findOne: mocks.tenantFindOne }),
    };
    mocks.productFind.mockReturnValue(selectLean([]));
    mocks.productFindOne.mockReturnValue({
      select: () => Promise.resolve(null),
    });
    mocks.productCreate.mockResolvedValue([{ _id: "product-created" }]);
    mocks.rowUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(status === "created" ? 1 : 0),
    );
    mocks.sessionUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mocks.mutationFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    mocks.recordMutation.mockResolvedValue({});
    mocks.completeImport.mockResolvedValue(undefined);
    mocks.withTransaction.mockImplementation(async (callback) => callback());
    mocks.endSession.mockResolvedValue(undefined);
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    } as never);
    mocks.recordAudit.mockResolvedValue({});
  });

  afterEach(() => {
    (mongoose.connection as any).db = undefined;
    vi.restoreAllMocks();
  });

  it("reuses a committed mutation on a retried row instead of creating twice", async () => {
    mocks.mutationFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          importOutcome: "created",
          target: "already-created",
          importMessage: "Product created.",
        }),
    });

    await expect(
      processProductImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });

    expect(mocks.mutationFindOne).toHaveBeenCalledWith({
      tenant: tenantId,
      session: sessionId,
      row: "row-2",
      isCanonicalResult: true,
    });
    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "created",
          resultRecord: "already-created",
        }),
      }),
    );
  });

  it("rechecks the required workspace module immediately before writing", async () => {
    mocks.tenantFindOne.mockResolvedValue({
      modules: { bookings: false },
      settings: { currency: "CZK" },
    });
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(status === "failed" ? 1 : 0),
    );

    await expect(
      processProductImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.productFind).not.toHaveBeenCalled();
    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage: "The required workspace module is no longer enabled.",
        }),
      }),
    );
  });

  it("updates only explicitly provided fields and import metadata", async () => {
    configureClaim(session("update"));
    const existing = {
      _id: "existing-product",
      name: "Shared Studio",
      kind: "open-studio",
      type: "workshop",
      stripeProductId: "stripe-product",
      stripePriceId: "stripe-price",
      importMetadata: { importKey: "original-import:2" },
    };
    mocks.productFind.mockReturnValue(selectLean([existing]));
    mocks.productFindOneAndUpdate.mockReturnValue({
      select: () => Promise.resolve(existing),
    });
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(status === "updated" ? 1 : 0),
    );

    await expect(
      processProductImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });

    const [, update] = mocks.productFindOneAndUpdate.mock.calls[0];
    expect(update.$set).toMatchObject({
      name: "Shared Studio",
      "importMetadata.source": "csv",
      "importMetadata.importId": sessionId,
      "importMetadata.importedBy": actorId,
    });
    expect(update.$set).not.toHaveProperty("description");
    expect(update.$set).not.toHaveProperty("price");
    expect(update.$set).not.toHaveProperty("stripeProductId");
    expect(update.$set).not.toHaveProperty("stripePriceId");
    expect(update.$set).not.toHaveProperty("importMetadata.importKey");
  });

  it("does not allow an update import to change product kind", async () => {
    configureClaim(session("update"));
    mocks.productFind.mockReturnValue(
      selectLean([
        {
          _id: "existing-class",
          name: "Shared Studio",
          kind: "class",
          type: "course",
        },
      ]),
    );
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(status === "failed" ? 1 : 0),
    );

    await expect(
      processProductImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage: "An import cannot change an existing product kind.",
        }),
      }),
    );
  });

  it("stops a queued import when the actor's permission was revoked", async () => {
    mocks.hasWorkspacePermission.mockReturnValue(false);

    await expect(
      processProductImportSession({ tenantId, sessionId }),
    ).rejects.toThrow(
      "The queued actor no longer has product import permission.",
    );

    expect(mocks.rowFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.productFind).not.toHaveBeenCalled();
    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: sessionId, tenant: tenantId }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          lastError: expect.objectContaining({
            code: "IMPORT_EXECUTION_FAILED",
          }),
        }),
      }),
    );
  });

  it("reports a location-slot index conflict as a failed import row with a useful explanation", async () => {
    mocks.productCreate.mockRejectedValueOnce({ code: 11000, keyPattern: { tenant: 1, location: 1 } });
    mocks.rowCountDocuments.mockImplementation(({ status }) => Promise.resolve(status === "failed" ? 1 : 0));
    await expect(processProductImportSession({ tenantId, sessionId })).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith({ _id: "row-2" }, { $set: {
      status: "failed", resultRecord: null,
      resultMessage: "This location already has an Open Studio product. Edit the existing product instead.",
    } });
    expect(mocks.recordMutation).not.toHaveBeenCalled();
  });

  it("does not resurrect a studio product archived after import validation", async () => {
    configureClaim(session("update"));
    mocks.productFind.mockReturnValue(selectLean([{ _id: "archived", kind: "open-studio", isArchived: true, isActive: false }]));
    mocks.rowCountDocuments.mockImplementation(({ status }) => Promise.resolve(status === "failed" ? 1 : 0));
    await expect(processProductImportSession({ tenantId, sessionId })).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });
    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.productCreate).not.toHaveBeenCalled();
  });
});
