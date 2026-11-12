import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowFindOneAndUpdate: vi.fn(),
  rowUpdateOne: vi.fn(),
  rowCountDocuments: vi.fn(),
  userFind: vi.fn(),
  userFindOne: vi.fn(),
  userExists: vi.fn(),
  userCreate: vi.fn(),
  userFindOneAndUpdate: vi.fn(),
  ensureMemberNumberCounter: vi.fn(),
  readAllocationEpoch: vi.fn(),
  assertAllocationEpoch: vi.fn(),
  allocateMemberNumber: vi.fn(),
  transitionMemberNumber: vi.fn(),
  potteryPieceUpdateMany: vi.fn(),
  membershipExists: vi.fn(),
  recordAudit: vi.fn(),
  mutationFindOne: vi.fn(),
  recordMutation: vi.fn(),
  completeImport: vi.fn(),
  tenantFindOne: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  hasWorkspacePermission: vi.fn(),
  assertReady: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
  credentialFindOne: vi.fn(),
  credentialDeleteMany: vi.fn(),
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
vi.mock("@/modules/data-import/data-import-credential.model.js", () => ({
  default: {
    findOne: mocks.credentialFindOne,
    deleteMany: mocks.credentialDeleteMany,
  },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    find: mocks.userFind,
    findOne: mocks.userFindOne,
    exists: mocks.userExists,
    create: mocks.userCreate,
    findOneAndUpdate: mocks.userFindOneAndUpdate,
  },
}));
vi.mock("@/modules/pottery-piece/pottery-piece.model.js", () => ({
  PotteryPiece: { updateMany: mocks.potteryPieceUpdateMany },
}));
vi.mock("@/modules/user/user-member-number.service.js", () => ({
  allocateUserMemberNumber: mocks.allocateMemberNumber,
  ensureUserMemberNumberCounterAtLeast: mocks.ensureMemberNumberCounter,
  readUserMemberNumberAllocationEpoch: mocks.readAllocationEpoch,
  assertUserMemberNumberAllocationEpoch: mocks.assertAllocationEpoch,
  isValidUserMemberNumber: (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  USER_MEMBER_NUMBER_HISTORY_REASON: {
    CUSTOMER_IMPORT_CONFLICT: "customer_import_conflict",
    CUSTOMER_IMPORT_ASSIGNMENT: "customer_import_assignment",
  },
}));
vi.mock("@/modules/user/user-member-number.assignment.service.js", () => ({
  transitionUserMemberNumber: mocks.transitionMemberNumber,
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { exists: mocks.membershipExists },
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));

vi.mock("@/modules/data-import/data-import-mutation.model.js", () => ({
  default: { findOne: mocks.mutationFindOne },
}));

vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccess,
  hasWorkspacePermission: mocks.hasWorkspacePermission,
}));

vi.mock(
  "@/modules/data-import/services/commerce-import-readiness.service.js",
  () => ({ assertCommerceImportReady: mocks.assertReady }),
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

vi.mock(
  "@/modules/data-import/services/data-import-rollback-availability.service.js",
  () => ({ completeImportWithRollbackAvailability: mocks.completeImport }),
);

import { processCustomerImportSession } from "@/modules/data-import/services/data-import-execution.service.js";

const tenantId = new mongoose.Types.ObjectId().toString();
const actorId = new mongoose.Types.ObjectId();
const sessionId = new mongoose.Types.ObjectId().toString();
const rowId = new mongoose.Types.ObjectId();

const session = (strategy = "skip") => ({
  _id: new mongoose.Types.ObjectId(sessionId),
  tenant: new mongoose.Types.ObjectId(tenantId),
  createdBy: actorId,
  fileType: "csv",
  duplicateStrategy: strategy,
});

const configureSessionClaim = (value: any) => {
  mocks.sessionFindOneAndUpdate.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve(value),
    }),
  });
};

const configureRows = (rows: any[]) => {
  mocks.rowFind.mockReturnValue({
    sort: () => Promise.resolve(rows),
  });
  let nextRow = 0;
  mocks.rowFindOneAndUpdate.mockImplementation(() =>
    Promise.resolve(rows[nextRow++] || null),
  );
};

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["select", "session"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.lean = vi.fn(async () => value);
  chain.exec = vi.fn(async () => value);
  chain.then = (
    resolve: (result: T) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
};

describe("customer import execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureSessionClaim(session("skip"));
    configureRows([
      {
        _id: rowId,
        rowNumber: 2,
        normalized: { firstname: "Madonna", lastname: "" },
        duplicate: null,
      },
    ]);
    mocks.rowUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(status === "created" ? 1 : 0),
    );
    mocks.sessionUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mocks.userFind.mockReturnValue(query([]));
    mocks.userFindOne.mockReturnValue(query(null));
    mocks.userExists.mockReturnValue(query(null));
    mocks.userCreate.mockResolvedValue([
      {
        _id: new mongoose.Types.ObjectId(),
      },
    ]);
    mocks.membershipExists.mockReturnValue({
      session: () => Promise.resolve(null),
    });
    mocks.mutationFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    mocks.recordMutation.mockResolvedValue({});
    mocks.ensureMemberNumberCounter.mockResolvedValue(undefined);
    mocks.readAllocationEpoch.mockResolvedValue(0);
    mocks.assertAllocationEpoch.mockResolvedValue(undefined);
    mocks.allocateMemberNumber.mockResolvedValue(10_001);
    mocks.transitionMemberNumber.mockResolvedValue({
      beforeRecord: {},
      afterRecord: {},
    });
    mocks.potteryPieceUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mocks.completeImport.mockResolvedValue(undefined);
    mocks.credentialDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mocks.tenantFindOne.mockResolvedValue({
      modules: { customers: true },
    });
    mocks.resolveWorkspaceAccess.mockResolvedValue({ status: "active" });
    mocks.hasWorkspacePermission.mockReturnValue(true);
    mocks.assertReady.mockResolvedValue(undefined);
    (mongoose.connection as any).db = {
      collection: () => ({ findOne: mocks.tenantFindOne }),
    };
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

  it("creates a name-only customer without a fake email or password", async () => {
    await expect(
      processCustomerImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });

    expect(mocks.userCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenant: tenantId,
          firstname: "Madonna",
          lastname: "",
          customId: expect.stringMatching(/^IMP-/),
          importMetadata: expect.objectContaining({
            importId: sessionId,
            importKey: sessionId + ":2",
          }),
        }),
      ],
      { session: expect.any(Object) },
    );
    const payload = mocks.userCreate.mock.calls[0][0][0];
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("password");
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: rowId },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "created" }),
      }),
    );
    expect(mocks.credentialDeleteMany).toHaveBeenCalledWith({
      tenant: tenantId,
      session: expect.any(mongoose.Types.ObjectId),
    });
    const fullPhoneScans = mocks.userFind.mock.calls.filter(
      ([filter]) => filter?.phone?.$nin,
    );
    expect(fullPhoneScans).toHaveLength(1);
  });

  it("initializes a new customer with a validated staged bcrypt hash", async () => {
    const passwordHash = `$2b$12$${"A".repeat(53)}`;
    const createdId = new mongoose.Types.ObjectId();
    configureSessionClaim({
      ...session("skip"),
      credentialImportConfirmed: true,
    });
    configureRows([
      {
        _id: rowId,
        rowNumber: 2,
        normalized: {
          firstname: "Anna",
          lastname: "Novak",
          email: "anna@example.com",
          passwordHashProvided: true,
        },
        duplicate: null,
      },
    ]);
    mocks.userCreate.mockResolvedValue([{ _id: createdId }]);
    mocks.credentialFindOne.mockReturnValue({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve({ passwordHash }),
        }),
      }),
    });
    mocks.userFindOneAndUpdate.mockReturnValue({
      select: () => Promise.resolve({ _id: createdId, password: passwordHash }),
    });

    await expect(
      processCustomerImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });

    expect(mocks.userCreate.mock.calls[0][0][0]).not.toHaveProperty("password");
    expect(mocks.userFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: createdId,
        tenant: tenantId,
        password: { $exists: false },
      }),
      { $set: { password: passwordHash } },
      expect.objectContaining({ timestamps: false, runValidators: true }),
    );
    expect(mocks.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delta: {
          importedPasswordHashDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }),
    );
  });

  it("rechecks current duplicates and skips existing customers by default", async () => {
    const existingId = new mongoose.Types.ObjectId();
    configureRows([
      {
        _id: rowId,
        rowNumber: 2,
        normalized: {
          firstname: "Anna",
          lastname: "Novak",
          email: "anna@example.com",
        },
        duplicate: { kind: "email", existingUserId: existingId },
      },
    ]);
    mocks.userFind.mockReturnValue({
      select: () => ({
        session: () => ({
          lean: () =>
            Promise.resolve([
              {
                _id: existingId,
                email: "anna@example.com",
                phone: "",
              },
            ]),
        }),
      }),
    });
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(status === "skipped" ? 1 : 0),
    );

    await expect(
      processCustomerImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({
      created: 0,
      updated: 0,
      skipped: 1,
      failed: 0,
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.userFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: rowId },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          resultUser: existingId,
        }),
      }),
    );
  });

  it("raises the counter above every requested number before processing rows", async () => {
    const rows = [
      {
        _id: new mongoose.Types.ObjectId(),
        rowNumber: 2,
        normalized: {
          firstname: "First",
          lastname: "Customer",
          memberNumber: 5,
          memberNumberResolution: "displace_customer",
        },
        duplicate: null,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        rowNumber: 3,
        normalized: {
          firstname: "Second",
          lastname: "Customer",
          memberNumber: 6,
          memberNumberResolution: "requested",
        },
        duplicate: null,
      },
    ];
    configureRows(rows);
    mocks.mutationFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          importOutcome: "created",
          target: new mongoose.Types.ObjectId(),
          importMessage: "Already committed.",
        }),
    });

    await processCustomerImportSession({ tenantId, sessionId });

    expect(mocks.ensureMemberNumberCounter).toHaveBeenCalledWith({
      tenantId,
      expectedEpoch: 0,
      minimum: 6,
    });
    expect(mocks.allocateMemberNumber).not.toHaveBeenCalled();
  });

  it("atomically displaces a conflicting customer and journals the auxiliary mutation", async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const importedId = new mongoose.Types.ObjectId();
    const historyAfter = [
      {
        number: 5,
        reason: "customer_import_conflict",
      },
    ];
    configureSessionClaim({
      ...session("skip"),
      preserveImportedMemberNumbers: true,
    });
    configureRows([
      {
        _id: rowId,
        rowNumber: 2,
        normalized: {
          firstname: "Anna",
          lastname: "Novak",
          memberNumber: 5,
          memberNumberResolution: "displace_customer",
          memberNumberOwnerId: String(ownerId),
        },
        duplicate: null,
      },
    ]);
    mocks.userFindOne.mockImplementation((filter: any) =>
      query(
        filter?.memberNumber === 5 ? { _id: ownerId, memberNumber: 5 } : null,
      ),
    );
    mocks.allocateMemberNumber.mockResolvedValue(7);
    mocks.transitionMemberNumber.mockResolvedValue({
      beforeRecord: {
        _id: ownerId,
        memberNumber: 5,
        memberNumberHistory: [],
      },
      afterRecord: {
        _id: ownerId,
        memberNumber: 7,
        memberNumberHistory: historyAfter,
      },
    });
    mocks.userCreate.mockResolvedValue([
      {
        _id: importedId,
        memberNumber: 5,
        memberNumberHistory: [],
      },
    ]);

    await expect(
      processCustomerImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });

    expect(mocks.allocateMemberNumber).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, minimum: 5 }),
    );
    expect(mocks.transitionMemberNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        userId: ownerId,
        expectedMemberNumber: 5,
        nextMemberNumber: 7,
        reason: "customer_import_conflict",
      }),
    );
    expect(mocks.userCreate.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({ memberNumber: 5 }),
    );
    expect(mocks.recordMutation).toHaveBeenCalledTimes(2);
    expect(mocks.recordMutation.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        isCanonicalResult: false,
        targetId: ownerId,
        affectedFields: ["memberNumber", "memberNumberHistory"],
        delta: {
          kind: "customer_member_number_displacement",
          importedCustomerId: String(importedId),
          requestedMemberNumber: 5,
          replacementMemberNumber: 7,
        },
      }),
    );
  });

  it("does not claim an import that another worker owns", async () => {
    configureSessionClaim(null);
    await expect(
      processCustomerImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ skipped: true, reason: "not_claimable" });
    expect(mocks.rowFind).not.toHaveBeenCalled();
  });

  it("refuses a stale imported range and requires validation before a worker retry", async () => {
    configureRows([
      {
        _id: rowId,
        rowNumber: 2,
        normalized: {
          firstname: "Synthetic",
          lastname: "",
          memberNumber: 10001,
        },
        duplicate: null,
      },
    ]);
    const error = Object.assign(
      new Error("Member-number allocation changed. Validate again."),
      {
        code: "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED",
        statusCode: 503,
      },
    );
    mocks.ensureMemberNumberCounter.mockRejectedValueOnce(error);

    await expect(
      processCustomerImportSession({ tenantId, sessionId }),
    ).rejects.toBe(error);

    expect(mocks.ensureMemberNumberCounter).toHaveBeenCalledWith({
      tenantId,
      minimum: 10001,
      expectedEpoch: 0,
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.rowFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.completeImport).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(expect.any(Object), {
      $set: expect.objectContaining({
        status: "failed",
        lastError: expect.objectContaining({ code: error.code }),
      }),
    });
    expect(mocks.sessionFindOneAndUpdate.mock.calls[0][0]).toMatchObject({
      "lastError.code": {
        $nin: [error.code, "MEMBER_NUMBER_ALLOCATION_PAUSED"],
      },
    });
  });

  it("aborts the whole execution when repair starts before a row transaction", async () => {
    const error = Object.assign(new Error("Allocation paused."), {
      code: "MEMBER_NUMBER_ALLOCATION_PAUSED",
      statusCode: 503,
    });
    mocks.assertAllocationEpoch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error);

    await expect(
      processCustomerImportSession({ tenantId, sessionId }),
    ).rejects.toBe(error);

    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).not.toHaveBeenCalled();
    expect(mocks.completeImport).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledOnce();
    expect(mocks.sessionFindOneAndUpdate.mock.calls[0][0]).toMatchObject({
      "lastError.code": {
        $nin: ["MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED", error.code],
      },
    });
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(expect.any(Object), {
      $set: expect.objectContaining({
        lastError: expect.objectContaining({ code: error.code }),
      }),
    });
  });
});
