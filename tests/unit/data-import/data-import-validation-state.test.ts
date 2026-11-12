import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindOne: vi.fn(),
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowBulkWrite: vi.fn(),
  userFind: vi.fn(),
  membershipFind: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/modules/data-import/data-import-session.model.js", () => ({
  default: {
    findOne: mocks.sessionFindOne,
    findOneAndUpdate: mocks.sessionFindOneAndUpdate,
    updateOne: mocks.sessionUpdateOne,
  },
}));
vi.mock("@/modules/data-import/data-import-row.model.js", () => ({
  default: { find: mocks.rowFind, bulkWrite: mocks.rowBulkWrite },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { find: mocks.userFind },
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { find: mocks.membershipFind },
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));

import { validateCustomerImportSession } from "@/modules/data-import/services/data-import.service.js";

const tenantId = new mongoose.Types.ObjectId().toString();
const sessionId = new mongoose.Types.ObjectId().toString();
const current = {
  _id: new mongoose.Types.ObjectId(sessionId),
  tenant: new mongoose.Types.ObjectId(tenantId),
  entityType: "customers",
  status: "uploaded",
  headers: ["Name", "Email"],
  fileHash: "a".repeat(64),
  createdBy: new mongoose.Types.ObjectId(),
};

const queryResult = (value: unknown) => ({
  lean: () => Promise.resolve(value),
});

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["select", "sort"]) chain[method] = () => chain;
  chain.lean = () => Promise.resolve(value);
  return chain;
};

describe("customer import validation state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionFindOne.mockReturnValue(queryResult(current));
    mocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 1 });
    mocks.userFind.mockReturnValue(query([]));
    mocks.membershipFind.mockReturnValue(query([]));
    mocks.recordAudit.mockResolvedValue({});
  });

  it("rejects an invalid mapping before claiming the session", async () => {
    await expect(
      validateCustomerImportSession({
        tenantId,
        sessionId,
        mapping: { email: "Email" },
        duplicateStrategy: "skip",
        actorId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_MAPPING_NAME_REQUIRED" });

    expect(mocks.sessionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled();
  });

  it("moves a claimed session to retryable failed state on processing errors", async () => {
    const failure = new Error("staged rows unavailable");
    mocks.sessionFindOneAndUpdate.mockReturnValue(queryResult(current));
    mocks.rowFind.mockReturnValue({
      sort: () => ({ lean: () => Promise.reject(failure) }),
    });

    await expect(
      validateCustomerImportSession({
        tenantId,
        sessionId,
        mapping: { fullName: "Name" },
        duplicateStrategy: "skip",
        actorId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toBe(failure);

    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: current._id,
        tenant: tenantId,
        status: "validating",
      }),
      {
        $set: expect.objectContaining({
          status: "failed",
          lastError: expect.objectContaining({
            code: "IMPORT_VALIDATION_FAILED",
          }),
        }),
      },
    );
  });

  it("plans collision allocation by default and explicit owner displacement only when preserved", async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const validationCurrent = {
      ...current,
      headers: ["Name", "Number"],
    };
    const rows = [
      {
        _id: new mongoose.Types.ObjectId(),
        rowNumber: 2,
        raw: { Name: "Anna Novak", Number: "5" },
      },
    ];
    const users = [
      {
        _id: ownerId,
        memberNumber: 5,
        tenantRole: "customer",
        roles: ["1023e"],
        updatedAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    ];
    const runValidation = async (preserveImportedMemberNumbers: boolean) => {
      vi.clearAllMocks();
      mocks.sessionFindOne.mockReturnValue(queryResult(validationCurrent));
      mocks.sessionFindOneAndUpdate
        .mockReturnValueOnce(
          queryResult({ ...validationCurrent, status: "validating" }),
        )
        .mockReturnValueOnce(
          queryResult({ ...validationCurrent, status: "validated" }),
        );
      mocks.rowFind.mockReturnValue(query(rows));
      mocks.userFind.mockReturnValue(query(users));
      mocks.membershipFind.mockReturnValue(query([]));
      mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 1 });
      mocks.recordAudit.mockResolvedValue({});

      await validateCustomerImportSession({
        tenantId,
        sessionId,
        mapping: { fullName: "Name", memberNumber: "Number" },
        duplicateStrategy: "skip",
        actorId: new mongoose.Types.ObjectId().toString(),
        preserveImportedMemberNumbers,
      });
      return {
        rowSet: mocks.rowBulkWrite.mock.calls[0][0][0].updateOne.update.$set,
        sessionSet:
          mocks.sessionFindOneAndUpdate.mock.calls[1][1].$set,
      };
    };

    const safeDefault = await runValidation(false);
    expect(safeDefault.rowSet.normalized).toMatchObject({
      memberNumber: 5,
      memberNumberResolution: "allocate_collision",
      memberNumberOwnerId: String(ownerId),
    });
    expect(safeDefault.sessionSet).toMatchObject({
      preserveImportedMemberNumbers: false,
      summary: {
        memberNumberCollisions: 1,
        memberNumberReassignments: 0,
      },
    });

    const preserved = await runValidation(true);
    expect(preserved.rowSet.normalized).toMatchObject({
      memberNumber: 5,
      memberNumberResolution: "displace_customer",
      memberNumberOwnerId: String(ownerId),
    });
    expect(preserved.sessionSet).toMatchObject({
      preserveImportedMemberNumbers: true,
      summary: {
        memberNumberCollisions: 1,
        memberNumberReassignments: 1,
      },
    });
    expect(preserved.sessionSet.validationRevision).not.toBe(
      safeDefault.sessionSet.validationRevision,
    );
  });

  it("rejects the second executable row that requests the same member number", async () => {
    const validationCurrent = {
      ...current,
      headers: ["Name", "Email", "Number"],
    };
    mocks.sessionFindOne.mockReturnValue(queryResult(validationCurrent));
    mocks.sessionFindOneAndUpdate
      .mockReturnValueOnce(
        queryResult({ ...validationCurrent, status: "validating" }),
      )
      .mockReturnValueOnce(
        queryResult({ ...validationCurrent, status: "validated" }),
      );
    mocks.rowFind.mockReturnValue(
      query([
        {
          _id: new mongoose.Types.ObjectId(),
          rowNumber: 2,
          raw: {
            Name: "First Customer",
            Email: "first@example.com",
            Number: "12",
          },
        },
        {
          _id: new mongoose.Types.ObjectId(),
          rowNumber: 3,
          raw: {
            Name: "Second Customer",
            Email: "second@example.com",
            Number: "12",
          },
        },
      ]),
    );
    mocks.userFind.mockReturnValue(query([]));
    mocks.membershipFind.mockReturnValue(query([]));
    mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 2 });

    await validateCustomerImportSession({
      tenantId,
      sessionId,
      mapping: {
        fullName: "Name",
        email: "Email",
        memberNumber: "Number",
      },
      duplicateStrategy: "skip",
      actorId: new mongoose.Types.ObjectId().toString(),
    });

    const operations = mocks.rowBulkWrite.mock.calls[0][0];
    expect(operations[0].updateOne.update.$set.status).toBe("valid");
    expect(operations[1].updateOne.update.$set).toMatchObject({
      status: "invalid",
      issues: [
        expect.objectContaining({
          code: "CUSTOMER_MEMBER_NUMBER_DUPLICATE_IN_FILE",
          field: "memberNumber",
          severity: "error",
        }),
      ],
    });
  });

  it("never plans displacement when the current number owner is protected", async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const validationCurrent = {
      ...current,
      headers: ["Name", "Number"],
    };
    mocks.sessionFindOne.mockReturnValue(queryResult(validationCurrent));
    mocks.sessionFindOneAndUpdate
      .mockReturnValueOnce(
        queryResult({ ...validationCurrent, status: "validating" }),
      )
      .mockReturnValueOnce(
        queryResult({ ...validationCurrent, status: "validated" }),
      );
    mocks.rowFind.mockReturnValue(
      query([
        {
          _id: new mongoose.Types.ObjectId(),
          rowNumber: 2,
          raw: { Name: "Imported Customer", Number: "15" },
        },
      ]),
    );
    mocks.userFind.mockReturnValue(
      query([
        {
          _id: ownerId,
          memberNumber: 15,
          tenantRole: "customer",
          roles: ["1023e"],
          updatedAt: new Date(),
        },
      ]),
    );
    mocks.membershipFind.mockReturnValue(query([{ user: ownerId }]));
    mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 1 });

    await validateCustomerImportSession({
      tenantId,
      sessionId,
      mapping: { fullName: "Name", memberNumber: "Number" },
      duplicateStrategy: "skip",
      actorId: new mongoose.Types.ObjectId().toString(),
      preserveImportedMemberNumbers: true,
    });

    const rowSet = mocks.rowBulkWrite.mock.calls[0][0][0].updateOne.update.$set;
    expect(rowSet.normalized).toMatchObject({
      memberNumber: 15,
      memberNumberResolution: "allocate_collision",
      memberNumberOwnerId: String(ownerId),
    });
    expect(rowSet.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CUSTOMER_MEMBER_NUMBER_PROTECTED_OWNER",
          severity: "warning",
        }),
      ]),
    );
    expect(
      mocks.sessionFindOneAndUpdate.mock.calls[1][1].$set.summary,
    ).toMatchObject({
      memberNumberCollisions: 1,
      memberNumberReassignments: 0,
    });
  });

  it("does not let an unrelated-invalid row reserve a later valid member number", async () => {
    const validationCurrent = {
      ...current,
      headers: ["Name", "Number"],
    };
    mocks.sessionFindOne.mockReturnValue(queryResult(validationCurrent));
    mocks.sessionFindOneAndUpdate
      .mockReturnValueOnce(
        queryResult({ ...validationCurrent, status: "validating" }),
      )
      .mockReturnValueOnce(
        queryResult({ ...validationCurrent, status: "validated" }),
      );
    mocks.rowFind.mockReturnValue(
      query([
        {
          _id: new mongoose.Types.ObjectId(),
          rowNumber: 2,
          raw: { Name: "", Number: "9" },
        },
        {
          _id: new mongoose.Types.ObjectId(),
          rowNumber: 3,
          raw: { Name: "Valid Customer", Number: "9" },
        },
      ]),
    );
    mocks.userFind.mockReturnValue(query([]));
    mocks.membershipFind.mockReturnValue(query([]));
    mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 2 });
    mocks.recordAudit.mockResolvedValue({});

    await validateCustomerImportSession({
      tenantId,
      sessionId,
      mapping: { fullName: "Name", memberNumber: "Number" },
      duplicateStrategy: "skip",
      actorId: new mongoose.Types.ObjectId().toString(),
    });

    const operations = mocks.rowBulkWrite.mock.calls[0][0];
    expect(operations[0].updateOne.update.$set.status).toBe("invalid");
    expect(operations[1].updateOne.update.$set).toMatchObject({
      status: "valid",
      normalized: {
        memberNumber: 9,
        memberNumberResolution: "requested",
      },
    });
    expect(operations[1].updateOne.update.$set.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CUSTOMER_MEMBER_NUMBER_DUPLICATE_IN_FILE",
        }),
      ]),
    );
  });
});
