import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processStaged: vi.fn((args) => args),
  loadGuard: vi.fn(),
  planFind: vi.fn(),
  planFindOne: vi.fn(),
  planCreate: vi.fn(),
  versionFind: vi.fn(),
  versionCreate: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
  recordMutation: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/staged-import-execution.service.js",
  () => ({ processStagedImportSession: mocks.processStaged }),
);
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: {
    find: mocks.planFind,
    findOne: mocks.planFindOne,
    create: mocks.planCreate,
  },
}));
vi.mock("@/modules/membership/membership-plan-version.model.js", () => ({
  default: { find: mocks.versionFind, create: mocks.versionCreate },
}));
vi.mock(
  "@/modules/data-import/services/commerce-import-execution.utils.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/modules/data-import/services/commerce-import-execution.utils.js")
      >();
    return { ...actual, loadCommerceImportGuard: mocks.loadGuard };
  },
);

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

import { processMembershipPlanImportSession } from "@/modules/data-import/services/membership-plan-import-execution.service.js";

const tenantId = "64b64b64b64b64b64b64b64b";
const actorId = "64a64a64a64a64a64a64a64a";

const normalized = {
  externalId: "PLAN-1",
  name: "Studio membership",
  description: "Imported plan",
  terms: "Terms",
  price: 1490,
  currency: "CZK",
  billingType: "recurring",
  billingInterval: "month",
  intervalCount: 1,
  durationDays: null,
  locationScope: "all",
  locationCodes: [],
  locationIds: [],
  creditAllowance: 8,
  discountPercent: null,
  customPerk: "",
  benefits: [
    {
      key: "credits",
      label: "Credits",
      type: "allowance",
      unit: "credit",
      quantity: 8,
      adjustable: true,
    },
  ],
  sortOrder: 5,
  status: "published",
  fingerprint: "f".repeat(64),
  providedFields: ["externalId", "name", "price", "billingType"],
  parseErrors: [],
};

const planFindResult = (records: Array<any>) => ({
  select: () => ({
    session: () => ({ lean: () => Promise.resolve(records) }),
  }),
});

const planFindOneResult = (record: any) => ({
  select: () => ({ session: () => Promise.resolve(record) }),
});

const executeRow = () => {
  processMembershipPlanImportSession({ tenantId, sessionId: "session-1" });
  return mocks.processStaged.mock.calls.at(-1)![0].executeRow;
};

describe("membership-plan import execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processStaged.mockImplementation((args) => args);
    mocks.loadGuard.mockResolvedValue({
      currency: "CZK",
      access: { locationAccess: { mode: "all", locationIds: [] } },
      tenant: { modules: { memberships: true } },
    });
    mocks.versionFind.mockReturnValue({
      distinct: () => ({ session: () => Promise.resolve([]) }),
    });
    mocks.planFind.mockReturnValue(planFindResult([]));
    mocks.versionCreate.mockResolvedValue([{ _id: "version-1" }]);
    mocks.planCreate.mockResolvedValue([{ _id: "plan-1" }]);
    mocks.withTransaction.mockImplementation(async (callback) => callback());
    mocks.endSession.mockResolvedValue(undefined);
    mocks.recordMutation.mockResolvedValue({});
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    } as never);
  });

  it("creates the published version and stable plan atomically", async () => {
    const result = await executeRow()({
      tenantId,
      sessionId: "session-1",
      actorId,
      session: { fileType: "csv", duplicateStrategy: "skip" },
      row: { rowNumber: 2, normalized, duplicate: null },
    });

    expect(result).toEqual({
      action: "created",
      recordId: "plan-1",
      message: "Membership plan imported.",
    });
    expect(mocks.versionCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenant: expect.any(mongoose.Types.ObjectId),
          version: 1,
          status: "published",
          name: "Studio membership",
          prices: [{ currency: "CZK", amountMinor: 149_000 }],
        }),
      ],
      { session: expect.any(Object) },
    );
    expect(mocks.planCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          status: "published",
          currentPublishedVersion: "version-1",
          versionCounter: 1,
          importMetadata: expect.objectContaining({
            source: "csv",
            importId: "session-1",
            importKey: "session-1:2",
            externalId: "PLAN-1",
            fingerprint: "f".repeat(64),
          }),
        }),
      ],
      { session: expect.any(Object) },
    );
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing identity without opening a transaction in skip mode", async () => {
    const existing = {
      _id: "plan-existing",
      status: "published",
      importMetadata: {
        externalId: "PLAN-1",
        importKey: "old-session:2",
      },
    };
    mocks.planFind.mockReturnValue(planFindResult([existing]));

    await expect(
      executeRow()({
        tenantId,
        sessionId: "session-1",
        actorId,
        session: { fileType: "csv", duplicateStrategy: "skip" },
        row: { rowNumber: 2, normalized, duplicate: null },
      }),
    ).resolves.toEqual({
      action: "skipped",
      recordId: "plan-existing",
      message: "Existing membership plan skipped.",
    });

    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(mocks.versionCreate).not.toHaveBeenCalled();
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });

  it("rechecks import ownership inside the update transaction", async () => {
    const existing = {
      _id: "plan-existing",
      status: "published",
      importMetadata: {
        externalId: "PLAN-1",
        importKey: "old-session:2",
      },
    };
    mocks.planFind.mockReturnValue(planFindResult([existing]));
    mocks.planFindOne.mockReturnValue(
      planFindOneResult({
        _id: "plan-existing",
        status: "published",
        importMetadata: null,
      }),
    );

    await expect(
      executeRow()({
        tenantId,
        sessionId: "session-1",
        actorId,
        session: { fileType: "csv", duplicateStrategy: "update" },
        row: {
          rowNumber: 2,
          normalized,
          duplicate: { existingRecordId: "plan-existing" },
        },
      }),
    ).rejects.toThrow(
      "Membership plan update protection changed after validation.",
    );

    expect(mocks.versionCreate).not.toHaveBeenCalled();
    expect(mocks.planCreate).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("does not create another immutable version when row completion retries after commit", async () => {
    let stored: any = null;
    mocks.planFind.mockImplementation(() =>
      planFindResult(stored ? [stored] : []),
    );
    mocks.planCreate.mockImplementation(async ([payload]) => {
      stored = { ...payload, _id: "plan-1" };
      return [stored];
    });

    const run = executeRow();
    const args = {
      tenantId,
      sessionId: "session-1",
      actorId,
      session: { fileType: "csv", duplicateStrategy: "update" },
      row: { rowNumber: 2, normalized, duplicate: null },
    };

    await expect(run(args)).resolves.toMatchObject({ action: "created" });
    await expect(run(args)).resolves.toEqual({
      action: "skipped",
      recordId: "plan-1",
      message: "Membership plan row was already applied.",
    });

    expect(mocks.versionCreate).toHaveBeenCalledTimes(1);
    expect(mocks.planCreate).toHaveBeenCalledTimes(1);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
  });
});
