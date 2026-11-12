import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processStaged: vi.fn((args) => args),
  loadGuard: vi.fn(),
  allocationFind: vi.fn(),
  allocationFindOne: vi.fn(),
  allocationCreate: vi.fn(),
  allocationFindOneAndUpdate: vi.fn(),
  userFindOne: vi.fn(),
  moneyCreditFindOne: vi.fn(),
  changeBalance: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
  recordMutation: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/staged-import-execution.service.js",
  () => ({ processStagedImportSession: mocks.processStaged }),
);
vi.mock("@/modules/money-credit/credit-import-allocation.model.js", () => ({
  default: {
    find: mocks.allocationFind,
    findOne: mocks.allocationFindOne,
    create: mocks.allocationCreate,
    findOneAndUpdate: mocks.allocationFindOneAndUpdate,
  },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.userFindOne },
}));
vi.mock("@/modules/money-credit/money-credit.model.js", () => ({
  MoneyCredit: { findOne: mocks.moneyCreditFindOne },
}));
vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({
  moneyCreditService: { changeBalance: mocks.changeBalance },
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

import { processCreditImportSession } from "@/modules/data-import/services/credit-import-execution.service.js";

const tenantId = "64b64b64b64b64b64b64b64b";
const actorId = "64a64a64a64a64a64a64a64a";
const customerId = "64c64c64c64c64c64c64c64c";
const sessionId = "session-1";

const normalized = (balanceMinor = 12_500) => ({
  externalId: "CREDIT-1",
  customerExternalId: "CUSTOMER-1",
  balance: balanceMinor / 100,
  balanceMinor,
  currency: "CZK",
  note: "Opening balance",
  customerId,
  fingerprint: "f".repeat(64),
  providedFields: [
    "externalId",
    "customerExternalId",
    "balance",
    "currency",
    "note",
  ],
  parseErrors: [],
});

const allocationQuery = (records: any[]) => ({
  session: () => ({ lean: () => Promise.resolve(records) }),
});

const allocationFindOneQuery = (record: any) => ({
  lean: () => Promise.resolve(record),
});

const userQuery = (record: any = { _id: customerId }) => ({
  select: () => ({
    session: () => ({ lean: () => Promise.resolve(record) }),
  }),
});

const moneyCreditQuery = (record: any = null) => ({
  session: () => ({ lean: () => Promise.resolve(record) }),
});

const executeRow = () => {
  processCreditImportSession({ tenantId, sessionId });
  return mocks.processStaged.mock.calls.at(-1)![0].executeRow;
};

const rowArgs = ({
  balanceMinor = 12_500,
  duplicateStrategy = "update",
  duplicate = null,
}: {
  balanceMinor?: number;
  duplicateStrategy?: "skip" | "update";
  duplicate?: any;
} = {}) => ({
  tenantId,
  sessionId,
  actorId,
  session: { fileType: "csv", duplicateStrategy },
  row: { rowNumber: 2, normalized: normalized(balanceMinor), duplicate },
});

describe("credit import execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processStaged.mockImplementation((args) => args);
    mocks.loadGuard.mockResolvedValue({
      currency: "CZK",
      access: { locationAccess: { mode: "all", locationIds: [] } },
      tenant: { modules: { credits: true } },
    });
    mocks.allocationFind.mockReturnValue(allocationQuery([]));
    mocks.allocationFindOne.mockReturnValue(allocationFindOneQuery(null));
    mocks.userFindOne.mockReturnValue(userQuery());
    mocks.moneyCreditFindOne.mockReturnValue(moneyCreditQuery());
    mocks.changeBalance.mockResolvedValue({ newBalanceMinor: 12_500 });
    mocks.allocationCreate.mockResolvedValue([{ _id: "allocation-1" }]);
    mocks.allocationFindOneAndUpdate.mockResolvedValue({ _id: "allocation-1" });
    mocks.withTransaction.mockImplementation(async (callback) => callback());
    mocks.endSession.mockResolvedValue(undefined);
    mocks.recordMutation.mockResolvedValue({});
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    } as never);
  });

  it("creates the source allocation and positive migration ledger mutation in one transaction", async () => {
    await expect(executeRow()(rowArgs())).resolves.toEqual({
      action: "created",
      recordId: "allocation-1",
      message: "Credit source allocation imported.",
    });

    expect(mocks.changeBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        userId: customerId,
        amountDelta: 125,
        transaction: expect.objectContaining({
          type: "migration_credit",
          currency: "CZK",
          idempotencyKey: expect.stringMatching(/^credit-import:.+:r1$/),
        }),
        session: expect.any(Object),
      }),
    );
    expect(mocks.allocationCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenant: expect.any(mongoose.Types.ObjectId),
          user: expect.any(mongoose.Types.ObjectId),
          externalId: "CREDIT-1",
          importKey: `${sessionId}:2`,
          lastMutationKey: `${sessionId}:2`,
          targetAmountMinor: 12_500,
          revision: 1,
        }),
      ],
      { session: expect.any(Object) },
    );
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("uses a signed migration debit for a safe target decrease", async () => {
    const existing = {
      _id: "allocation-1",
      tenant: tenantId,
      user: customerId,
      externalId: "CREDIT-1",
      fingerprint: "f".repeat(64),
      importKey: "older-session:2",
      importId: "older-session",
      lastMutationKey: "older-session:2",
      targetAmountMinor: 12_500,
      currency: "CZK",
      revision: 3,
      note: "Original note",
    };
    mocks.allocationFind.mockReturnValue(allocationQuery([existing]));
    mocks.userFindOne.mockReturnValue(
      userQuery({
        _id: customerId,
        moneyCreditsMinor: 12_500,
        moneyCredits: 125,
      }),
    );
    mocks.moneyCreditFindOne.mockReturnValue(
      moneyCreditQuery({
        user: customerId,
        balanceMinor: 12_500,
        balance: 125,
        currency: "CZK",
        transactions: [],
      }),
    );
    mocks.allocationFindOneAndUpdate.mockResolvedValue({ _id: existing._id });

    await expect(
      executeRow()(
        rowArgs({
          balanceMinor: 10_000,
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).resolves.toEqual({
      action: "updated",
      recordId: "allocation-1",
      message: "Credit allocation delta applied.",
    });

    expect(mocks.changeBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        amountDelta: -25,
        transaction: expect.objectContaining({
          type: "migration_debit",
          idempotencyKey: "credit-import:allocation-1:r4",
        }),
        session: expect.any(Object),
      }),
    );
    expect(mocks.allocationFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "allocation-1", tenant: tenantId, revision: 3 },
      expect.objectContaining({
        $set: expect.objectContaining({
          targetAmountMinor: 10_000,
          revision: 4,
          lastMutationKey: `${sessionId}:2`,
        }),
      }),
      expect.objectContaining({ session: expect.any(Object) }),
    );
  });

  it("does not mutate when permission or module access is revoked inside the transaction", async () => {
    mocks.loadGuard
      .mockResolvedValueOnce({
        currency: "CZK",
        access: { locationAccess: { mode: "all", locationIds: [] } },
        tenant: { modules: { credits: true } },
      })
      .mockRejectedValueOnce(
        new Error("The queued actor no longer has permission for this import."),
      );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "The queued actor no longer has permission for this import.",
    );

    expect(mocks.userFindOne).not.toHaveBeenCalled();
    expect(mocks.changeBalance).not.toHaveBeenCalled();
    expect(mocks.allocationCreate).not.toHaveBeenCalled();
    expect(mocks.allocationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("rejects a compare-and-set race so the transaction can roll back the ledger delta", async () => {
    const existing = {
      _id: "allocation-1",
      user: customerId,
      externalId: "CREDIT-1",
      fingerprint: "f".repeat(64),
      importKey: "older-session:2",
      importId: "older-session",
      lastMutationKey: "older-session:2",
      targetAmountMinor: 12_500,
      currency: "CZK",
      revision: 3,
      note: "Original note",
    };
    mocks.allocationFind.mockReturnValue(allocationQuery([existing]));
    mocks.userFindOne.mockReturnValue(
      userQuery({
        _id: customerId,
        moneyCreditsMinor: 12_500,
        moneyCredits: 125,
      }),
    );
    mocks.moneyCreditFindOne.mockReturnValue(
      moneyCreditQuery({
        user: customerId,
        balanceMinor: 12_500,
        balance: 125,
        currency: "CZK",
        transactions: [],
      }),
    );
    mocks.allocationFindOneAndUpdate.mockResolvedValue(null);

    await expect(
      executeRow()(
        rowArgs({
          balanceMinor: 10_000,
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).rejects.toThrow("Credit allocation revision changed after validation.");

    expect(mocks.changeBalance).toHaveBeenCalledTimes(1);
    expect(mocks.allocationCreate).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("does not append another ledger mutation when row completion is retried after commit", async () => {
    let stored: any = null;
    mocks.allocationFind.mockImplementation(() =>
      allocationQuery(stored ? [stored] : []),
    );
    mocks.allocationCreate.mockImplementation(async ([payload]) => {
      stored = { ...payload, _id: "allocation-1" };
      return [stored];
    });

    const run = executeRow();
    await expect(run(rowArgs())).resolves.toMatchObject({ action: "created" });
    await expect(run(rowArgs())).resolves.toEqual({
      action: "skipped",
      recordId: "allocation-1",
      message: "Credit allocation row was already applied.",
    });

    expect(mocks.changeBalance).toHaveBeenCalledTimes(1);
    expect(mocks.allocationCreate).toHaveBeenCalledTimes(1);
    expect(mocks.allocationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the User and canonical ledger balance mirrors disagree", async () => {
    mocks.userFindOne.mockReturnValue(
      userQuery({
        _id: customerId,
        moneyCreditsMinor: 5_000,
        moneyCredits: 50,
      }),
    );
    mocks.moneyCreditFindOne.mockReturnValue(
      moneyCreditQuery({
        user: customerId,
        balanceMinor: 4_000,
        balance: 40,
        currency: "CZK",
        transactions: [],
      }),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "Customer and credit ledger balance mirrors disagree.",
    );

    expect(mocks.changeBalance).not.toHaveBeenCalled();
    expect(mocks.allocationCreate).not.toHaveBeenCalled();
    expect(mocks.allocationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("allows an empty legacy ledger in another currency to converge", async () => {
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, moneyCreditsMinor: 0, moneyCredits: 0 }),
    );
    mocks.moneyCreditFindOne.mockReturnValue(
      moneyCreditQuery({
        user: customerId,
        balanceMinor: 0,
        balance: 0,
        currency: "EUR",
        transactions: [],
      }),
    );

    await expect(executeRow()(rowArgs())).resolves.toMatchObject({
      action: "created",
      recordId: "allocation-1",
    });

    expect(mocks.changeBalance).toHaveBeenCalledTimes(1);
    expect(mocks.allocationCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-empty credit ledger in another currency", async () => {
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, moneyCreditsMinor: 0, moneyCredits: 0 }),
    );
    mocks.moneyCreditFindOne.mockReturnValue(
      moneyCreditQuery({
        user: customerId,
        balanceMinor: 100,
        balance: 1,
        currency: "EUR",
        transactions: [{ type: "added" }],
      }),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "The non-empty credit ledger uses another currency.",
    );

    expect(mocks.changeBalance).not.toHaveBeenCalled();
    expect(mocks.allocationCreate).not.toHaveBeenCalled();
  });
});
