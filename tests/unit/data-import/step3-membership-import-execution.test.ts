import fs from "node:fs";
import path from "node:path";

import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processStaged: vi.fn((args) => args),
  loadGuard: vi.fn(),
  membershipFind: vi.fn(),
  membershipFindOne: vi.fn(),
  membershipExists: vi.fn(),
  membershipCreate: vi.fn(),
  userFindOne: vi.fn(),
  planFindOne: vi.fn(),
  versionFindOne: vi.fn(),
  locationExists: vi.fn(),
  balanceFind: vi.fn(),
  ledgerFind: vi.fn(),
  invoiceExists: vi.fn(),
  orderExists: vi.fn(),
  appendAdjustment: vi.fn(),
  terminalize: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
  recordMutation: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/staged-import-execution.service.js",
  () => ({ processStagedImportSession: mocks.processStaged }),
);
vi.mock("@/modules/membership/user-membership.model.js", () => ({
  default: {
    find: mocks.membershipFind,
    findOne: mocks.membershipFindOne,
    exists: mocks.membershipExists,
    create: mocks.membershipCreate,
  },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.userFindOne },
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: { findOne: mocks.planFindOne },
}));
vi.mock("@/modules/membership/membership-plan-version.model.js", () => ({
  default: { findOne: mocks.versionFindOne },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: { exists: mocks.locationExists },
}));
vi.mock(
  "@/modules/membership/membership-entitlement-balance.schema.js",
  () => ({ default: { find: mocks.balanceFind } }),
);
vi.mock("@/modules/membership/membership-entitlement-ledger.schema.js", () => ({
  default: { find: mocks.ledgerFind },
}));
vi.mock("@/modules/membership/membership-invoice.schema.js", () => ({
  default: { exists: mocks.invoiceExists },
}));
vi.mock("@/modules/order/order.model.js", () => ({
  default: { exists: mocks.orderExists },
}));
vi.mock(
  "@/modules/membership/services/membership-entitlement.service.js",
  () => ({ appendMembershipImportAdjustment: mocks.appendAdjustment }),
);
vi.mock(
  "@/modules/membership/services/membership-lifecycle.service.js",
  () => ({ terminalizeMembership: mocks.terminalize }),
);
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

import { processMembershipImportSession } from "@/modules/data-import/services/membership-import-execution.service.js";

const tenantId = "64b64b64b64b64b64b64b64b";
const actorId = "64a64a64a64a64a64a64a64a";
const customerId = "64c64c64c64c64c64c64c64c";
const planId = "64d64d64d64d64d64d64d64d";
const versionId = "64e64e64e64e64e64e64e64e";
const locationId = "64f64f64f64f64f64f64f64f";
const sessionId = "session-1";
const startedAt = "2026-08-01T00:00:00.000Z";
const periodStart = "2026-08-01T00:00:00.000Z";
const periodEnd = "2026-09-01T00:00:00.000Z";
const updatedAt = new Date("2026-08-02T12:00:00.000Z");

const creditBenefit = {
  key: "credits",
  label: "Credits",
  type: "allowance",
  unit: "credit",
  quantity: 10,
  adjustable: true,
};
const visitBenefit = {
  key: "visits",
  label: "Visits",
  type: "allowance",
  unit: "visit",
  quantity: 4,
  adjustable: true,
};

const versionRecord = (overrides: Record<string, unknown> = {}) => ({
  _id: versionId,
  tenant: tenantId,
  plan: planId,
  version: 1,
  status: "published",
  name: "Monthly Studio",
  description: "Imported plan",
  terms: "Terms",
  prices: [{ currency: "CZK", amountMinor: 149_000 }],
  billing: { type: "recurring", interval: "month", intervalCount: 1 },
  locationScope: { type: "all", locationIds: [] },
  benefits: [creditBenefit],
  ...overrides,
});

const snapshotForVersion = (version: any) => ({
  version: Number(version.version),
  name: version.name,
  description: version.description || "",
  terms: version.terms || "",
  prices: version.prices || [],
  billing: version.billing,
  locationScope: version.locationScope,
  benefits: version.benefits || [],
});

const normalized = (overrides: Record<string, unknown> = {}) => ({
  externalId: "MEMBERSHIP-1",
  customerExternalId: "CUSTOMER-1",
  planExternalId: "PLAN-1",
  planName: "Monthly Studio",
  planVersion: 1,
  status: "active",
  startedAt,
  periodStart,
  periodEnd,
  cancelledAt: "",
  currency: "CZK",
  amount: 1490,
  amountMinor: 149_000,
  allowanceBalances: { credits: 5 },
  allowanceTargets: { credits: 5 },
  note: "Opening balance",
  customerId,
  planId,
  planVersionId: versionId,
  fingerprint: "f".repeat(64),
  providedFields: [
    "externalId",
    "customerExternalId",
    "planExternalId",
    "status",
    "startedAt",
    "periodStart",
    "periodEnd",
    "currency",
    "amount",
    "allowanceBalances",
    "note",
  ],
  parseErrors: [],
  ...overrides,
});

const membershipQuery = (records: any[]) => ({
  distinct: () => ({
    session: () => Promise.resolve(records.map((record) => record._id)),
  }),
  select: () => ({
    session: () => ({
      lean: () => Promise.resolve(records),
      exec: () => Promise.resolve(records),
    }),
  }),
});

const membershipFindOneQuery = (record: any) => ({
  select: () => ({
    lean: () => Promise.resolve(record),
    session: () => Promise.resolve(record),
  }),
});

const leanSessionQuery = (record: any) => ({
  session: () => ({ lean: () => Promise.resolve(record) }),
});

const userQuery = (record: any) => ({
  select: () => ({ session: () => Promise.resolve(record) }),
});

const existsQuery = (record: any) => ({
  session: () => Promise.resolve(record),
});

const balanceQuery = (records: any[]) => ({
  select: () => ({
    session: () => ({ lean: () => Promise.resolve(records) }),
  }),
  session: () => ({ lean: () => Promise.resolve(records) }),
});

const ledgerQuery = (records: any[]) => ({
  sort: () => ({
    session: () => ({ lean: () => Promise.resolve(records) }),
  }),
});

const existingMembership = (overrides: Record<string, unknown> = {}) => {
  const record = {
    _id: "membership-1",
    tenant: tenantId,
    user: customerId,
    plan: planId,
    planVersion: versionId,
    planSnapshot: snapshotForVersion(versionRecord()),
    selectedLocation: null,
    currency: "CZK",
    amountMinor: 149_000,
    status: "active",
    isOpen: true,
    startedAt: new Date(startedAt),
    currentPeriodStart: new Date(periodStart),
    currentPeriodEnd: new Date(periodEnd),
    cancelledAt: null,
    updatedAt,
    stripe: {
      connectedAccountId: "",
      customerId: "",
      subscriptionId: "",
      checkoutSessionId: "",
    },
    assignmentNote: "Prior note",
    importMetadata: {
      externalId: "MEMBERSHIP-1",
      importKey: "older-session:2",
      fingerprint: "f".repeat(64),
      allowanceTargets: { credits: 5 },
      allowanceRevision: 1,
      lastMutationKey: "older-session:2",
    },
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(function (this: Record<string, unknown>) {
      const { save: _save, toObject: _toObject, ...record } = this;
      return record;
    }),
    ...overrides,
  };

  mocks.membershipFindOne.mockReturnValue(membershipFindOneQuery(record));
  return record;
};

const executeRow = () => {
  processMembershipImportSession({ tenantId, sessionId });
  return mocks.processStaged.mock.calls.at(-1)![0].executeRow;
};

const rowArgs = ({
  value = normalized(),
  duplicateStrategy = "update",
  duplicate = null,
}: {
  value?: any;
  duplicateStrategy?: "skip" | "update";
  duplicate?: any;
} = {}) => ({
  tenantId,
  sessionId,
  actorId,
  session: { fileType: "csv", duplicateStrategy },
  row: { rowNumber: 2, normalized: value, duplicate },
});

const configureExistingConsistency = ({
  available = 5,
  benefits = [creditBenefit],
}: {
  available?: number;
  benefits?: any[];
} = {}) => {
  const balances = benefits.map((benefit, index) => ({
    benefitKey: benefit.key,
    unit: benefit.unit,
    available: benefit.key === "credits" ? available : 2,
    sequence: 1,
  }));
  const ledgers = balances.map((balance) => ({
    benefitKey: balance.benefitKey,
    sequence: balance.sequence,
    balanceAfter: balance.available,
  }));
  mocks.balanceFind.mockImplementation((filter) =>
    balanceQuery(
      filter?.unit === "credit"
        ? balances.filter((balance) => balance.unit === "credit")
        : balances,
    ),
  );
  mocks.ledgerFind.mockReturnValue(ledgerQuery(ledgers));
};

describe("membership import execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keep the imported August period open without depending on the run date.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    mocks.processStaged.mockImplementation((args) => args);
    mocks.loadGuard.mockResolvedValue({
      currency: "CZK",
      access: { locationAccess: { mode: "all", locationIds: [] } },
      tenant: { modules: { memberships: true } },
    });
    mocks.membershipFind.mockReturnValue(membershipQuery([]));
    mocks.membershipFindOne.mockReturnValue(membershipFindOneQuery(null));
    mocks.membershipExists.mockReturnValue(existsQuery(null));
    mocks.membershipCreate.mockResolvedValue([{ _id: "membership-1" }]);
    mocks.userFindOne.mockReturnValue(
      userQuery({
        _id: customerId,
        membershipCredits: 0,
        membershipCreditsExpireAt: null,
      }),
    );
    mocks.planFindOne.mockReturnValue(
      leanSessionQuery({ _id: planId, status: "published" }),
    );
    mocks.versionFindOne.mockReturnValue(leanSessionQuery(versionRecord()));
    mocks.locationExists.mockReturnValue(existsQuery({ _id: locationId }));
    configureExistingConsistency();
    mocks.invoiceExists.mockReturnValue(existsQuery(null));
    mocks.orderExists.mockReturnValue(existsQuery(null));
    mocks.appendAdjustment.mockResolvedValue({ _id: "ledger-1" });
    mocks.terminalize.mockResolvedValue(undefined);
    mocks.withTransaction.mockImplementation(async (callback) => callback());
    mocks.endSession.mockResolvedValue(undefined);
    mocks.recordMutation.mockResolvedValue({});
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    } as never);
  });

  it("creates an open snapshot and applies explicit and zero-default allowance targets", async () => {
    mocks.versionFindOne.mockReturnValue(
      leanSessionQuery(
        versionRecord({ benefits: [creditBenefit, visitBenefit] }),
      ),
    );
    const value = normalized({
      allowanceBalances: { credits: 7 },
      allowanceTargets: { credits: 7, visits: 0 },
    });

    await expect(executeRow()(rowArgs({ value }))).resolves.toEqual({
      action: "created",
      recordId: "membership-1",
      message: "Offline membership snapshot imported.",
    });

    expect(mocks.membershipCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          user: expect.any(mongoose.Types.ObjectId),
          plan: expect.any(mongoose.Types.ObjectId),
          planVersion: expect.any(mongoose.Types.ObjectId),
          status: "active",
          isOpen: true,
          autoRenew: false,
          assignmentSource: "migration",
          grantedPeriodKeys: [`migration:${periodStart}`],
          importMetadata: expect.objectContaining({
            importKey: `${sessionId}:2`,
            lastMutationKey: `${sessionId}:2`,
            allowanceTargets: { credits: 7, visits: 0 },
            allowanceRevision: 1,
          }),
        }),
      ],
      { session: expect.any(Object) },
    );
    expect(mocks.appendAdjustment).toHaveBeenCalledTimes(2);
    expect(mocks.appendAdjustment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        benefit: creditBenefit,
        delta: 7,
        idempotencyKey: "membership-import:membership-1:r1:credits",
        session: expect.any(Object),
      }),
    );
    expect(mocks.appendAdjustment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ benefit: visitBenefit, delta: 0 }),
    );
    expect(mocks.terminalize).not.toHaveBeenCalled();
  });

  it("creates a terminal snapshot without entitlement ledger or User mirror mutations", async () => {
    const value = normalized({
      status: "expired",
      startedAt: "2026-06-01T00:00:00.000Z",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      allowanceBalances: {},
      allowanceTargets: { credits: 0 },
    });

    await expect(executeRow()(rowArgs({ value }))).resolves.toMatchObject({
      action: "created",
      recordId: "membership-1",
    });

    expect(mocks.membershipCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          status: "expired",
          isOpen: false,
          renewsAt: null,
          grantedPeriodKeys: [],
          importMetadata: expect.objectContaining({
            allowanceTargets: { credits: 0 },
          }),
        }),
      ],
      { session: expect.any(Object) },
    );
    expect(mocks.appendAdjustment).not.toHaveBeenCalled();
    expect(mocks.terminalize).not.toHaveBeenCalled();
  });

  it("does not create or allocate again when row completion retries after commit", async () => {
    let stored: any = null;
    mocks.membershipFind.mockImplementation(() =>
      membershipQuery(stored ? [stored] : []),
    );
    mocks.membershipCreate.mockImplementation(async ([payload]) => {
      stored = { ...payload, _id: "membership-1", updatedAt: new Date() };
      return [stored];
    });

    const run = executeRow();
    await expect(run(rowArgs())).resolves.toMatchObject({ action: "created" });
    await expect(run(rowArgs())).resolves.toEqual({
      action: "skipped",
      recordId: "membership-1",
      message: "Membership row was already applied.",
    });

    expect(mocks.membershipCreate).toHaveBeenCalledTimes(1);
    expect(mocks.appendAdjustment).toHaveBeenCalledTimes(1);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts an identity-exact E11000 row replay", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: 11_000,
    });
    mocks.membershipCreate.mockRejectedValue(duplicate);
    mocks.membershipFindOne.mockReturnValue(
      membershipFindOneQuery(
        existingMembership({
          importMetadata: {
            externalId: "MEMBERSHIP-1",
            importKey: `${sessionId}:2`,
            fingerprint: "f".repeat(64),
            allowanceTargets: { credits: 5 },
            allowanceRevision: 1,
            lastMutationKey: `${sessionId}:2`,
          },
        }),
      ),
    );

    await expect(executeRow()(rowArgs())).resolves.toEqual({
      action: "skipped",
      recordId: "membership-1",
      message: "Membership row was already applied.",
    });

    expect(mocks.membershipFindOne).toHaveBeenCalledWith({
      tenant: tenantId,
      "importMetadata.lastMutationKey": `${sessionId}:2`,
    });
    expect(mocks.membershipCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an E11000 row belongs to another immutable identity", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: 11_000,
    });
    mocks.membershipCreate.mockRejectedValue(duplicate);
    mocks.membershipFindOne.mockReturnValue(
      membershipFindOneQuery(
        existingMembership({
          amountMinor: 200_000,
          importMetadata: {
            externalId: "MEMBERSHIP-1",
            importKey: `${sessionId}:2`,
            fingerprint: "f".repeat(64),
            allowanceTargets: { credits: 5 },
            allowanceRevision: 1,
            lastMutationKey: `${sessionId}:2`,
          },
        }),
      ),
    );

    await expect(executeRow()(rowArgs())).rejects.toBe(duplicate);
    expect(mocks.membershipCreate).toHaveBeenCalledTimes(1);
  });

  it("updates open per-key deltas while preserving an omitted allowance target", async () => {
    const current = existingMembership({
      planSnapshot: snapshotForVersion(
        versionRecord({ benefits: [creditBenefit, visitBenefit] }),
      ),
      importMetadata: {
        externalId: "MEMBERSHIP-1",
        importKey: "older-session:2",
        fingerprint: "f".repeat(64),
        allowanceTargets: { credits: 5, visits: 2 },
        allowanceRevision: 1,
        lastMutationKey: "older-session:2",
      },
    });
    mocks.membershipFind.mockReturnValue(membershipQuery([current]));
    mocks.versionFindOne.mockReturnValue(
      leanSessionQuery(
        versionRecord({ benefits: [creditBenefit, visitBenefit] }),
      ),
    );
    configureExistingConsistency({ benefits: [creditBenefit, visitBenefit] });
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, membershipCredits: 5 }),
    );
    const value = normalized({
      allowanceTargets: { credits: 7, visits: 2 },
      expectedUpdatedAt: updatedAt.toISOString(),
      providedFields: ["allowanceBalances"],
    });

    await expect(
      executeRow()(
        rowArgs({ value, duplicate: { existingRecordId: current._id } }),
      ),
    ).resolves.toMatchObject({ action: "updated", recordId: "membership-1" });

    expect(mocks.appendAdjustment).toHaveBeenCalledTimes(2);
    expect(mocks.appendAdjustment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ benefit: creditBenefit, delta: 2 }),
    );
    expect(mocks.appendAdjustment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ benefit: visitBenefit, delta: 0 }),
    );
    expect(current.importMetadata).toMatchObject({
      allowanceTargets: { credits: 7, visits: 2 },
      allowanceRevision: 2,
      lastMutationKey: `${sessionId}:2`,
    });
    expect(current.save).toHaveBeenCalledWith({ session: expect.any(Object) });
  });

  it("rolls back an unsafe negative allowance delta", async () => {
    const current = existingMembership();
    mocks.membershipFind.mockReturnValue(membershipQuery([current]));
    configureExistingConsistency({ available: 1 });
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, membershipCredits: 1 }),
    );
    mocks.appendAdjustment.mockImplementation(async ({ delta }) => {
      if (delta < 0)
        throw new Error(
          "Membership entitlement has insufficient available balance.",
        );
      return null;
    });

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            allowanceTargets: { credits: 2 },
            expectedUpdatedAt: updatedAt.toISOString(),
          }),
          duplicate: { existingRecordId: current._id },
        }),
      ),
    ).rejects.toThrow(
      "Membership entitlement has insufficient available balance.",
    );

    expect(mocks.appendAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ delta: -3 }),
    );
    expect(current.save).not.toHaveBeenCalled();
    expect(mocks.terminalize).not.toHaveBeenCalled();
  });

  it("terminalizes the actual live balance without reconciling the requested target first", async () => {
    const current = existingMembership();
    mocks.membershipFind.mockReturnValue(membershipQuery([current]));
    configureExistingConsistency({ available: 2 });
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, membershipCredits: 2 }),
    );
    const value = normalized({
      status: "cancelled",
      cancelledAt: "",
      allowanceTargets: { credits: 0 },
      expectedUpdatedAt: updatedAt.toISOString(),
      providedFields: ["status"],
    });

    await expect(
      executeRow()(
        rowArgs({ value, duplicate: { existingRecordId: current._id } }),
      ),
    ).resolves.toMatchObject({ action: "updated" });

    expect(mocks.appendAdjustment).not.toHaveBeenCalled();
    expect(current.importMetadata).toMatchObject({
      allowanceTargets: { credits: 5 },
      allowanceRevision: 2,
      lastMutationKey: `${sessionId}:2`,
    });
    expect(mocks.terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        membership: current,
        status: "cancelled",
        preserveUnknownCancelledAt: true,
        idempotencyPrefix: "membership-import:membership-1:terminal:r2",
        session: expect.any(Object),
      }),
    );
    expect(current.cancelledAt).toBeNull();
  });

  it("allows an idempotent same-terminal metadata update", async () => {
    const current = existingMembership({
      status: "cancelled",
      isOpen: false,
      cancelledAt: null,
    });
    mocks.membershipFind.mockImplementation((filter) =>
      membershipQuery(filter?.isOpen ? [] : [current]),
    );
    mocks.balanceFind.mockReturnValue(
      balanceQuery([
        { benefitKey: "credits", unit: "credit", available: 0, sequence: 2 },
      ]),
    );
    mocks.ledgerFind.mockReturnValue(
      ledgerQuery([{ benefitKey: "credits", sequence: 2, balanceAfter: 0 }]),
    );
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, membershipCredits: 0 }),
    );

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            status: "cancelled",
            note: "Corrected note",
            allowanceBalances: { credits: 0 },
            allowanceTargets: { credits: 0 },
            expectedUpdatedAt: updatedAt.toISOString(),
            providedFields: ["note", "allowanceBalances"],
          }),
          duplicate: { existingRecordId: current._id },
        }),
      ),
    ).resolves.toMatchObject({ action: "updated" });

    expect(mocks.appendAdjustment).not.toHaveBeenCalled();
    expect(mocks.terminalize).toHaveBeenCalledTimes(1);
    expect(current.assignmentNote).toBe("Corrected note");
    expect(current.importMetadata.allowanceTargets).toEqual({ credits: 5 });
  });

  it.each([
    [
      "native",
      { importMetadata: null },
      null,
      null,
      "Only offline import-owned memberships can be updated.",
    ],
    [
      "billing-managed",
      { stripe: { connectedAccountId: "acct_1" } },
      null,
      null,
      "Only offline import-owned memberships can be updated.",
    ],
    [
      "invoiced",
      {},
      { _id: "invoice-1" },
      null,
      "Paid, invoiced, or redeemed memberships cannot be updated.",
    ],
    [
      "order-linked",
      {},
      null,
      { _id: "order-1" },
      "Paid, invoiced, or redeemed memberships cannot be updated.",
    ],
  ])(
    "protects a %s membership from import updates",
    async (_kind, changes, invoice, order, message) => {
      const current = existingMembership(changes as Record<string, unknown>);
      mocks.membershipFind.mockReturnValue(membershipQuery([current]));
      mocks.invoiceExists.mockReturnValue(existsQuery(invoice));
      mocks.orderExists.mockReturnValue(existsQuery(order));

      await expect(
        executeRow()(
          rowArgs({
            value: normalized({ expectedUpdatedAt: updatedAt.toISOString() }),
            duplicate: { existingRecordId: current._id },
          }),
        ),
      ).rejects.toThrow(message);

      expect(mocks.appendAdjustment).not.toHaveBeenCalled();
      expect(current.save).not.toHaveBeenCalled();
      expect(mocks.terminalize).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "past_due", "paused"])(
    "treats a pre-existing %s membership as an open-create conflict",
    async (status) => {
      mocks.membershipExists.mockReturnValue(
        existsQuery({ _id: "other-membership", status, isOpen: true }),
      );

      await expect(executeRow()(rowArgs())).rejects.toThrow(
        "The customer already has an open membership.",
      );

      expect(mocks.membershipExists).toHaveBeenCalledWith({
        tenant: tenantId,
        user: customerId,
        isOpen: true,
      });
      expect(mocks.membershipCreate).not.toHaveBeenCalled();
    },
  );

  it("fails immutable identity changes before opening a transaction", async () => {
    mocks.membershipFind.mockReturnValue(
      membershipQuery([existingMembership({ user: "another-user" })]),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "Membership immutable identity changed after validation.",
    );

    expect(mongoose.startSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      "permission",
      () =>
        Promise.reject(
          new Error(
            "The queued actor no longer has permission for this import.",
          ),
        ),
      "The queued actor no longer has permission for this import.",
    ],
    [
      "module",
      () =>
        Promise.reject(
          new Error("The memberships module is no longer enabled."),
        ),
      "The memberships module is no longer enabled.",
    ],
    [
      "currency",
      () =>
        Promise.resolve({
          currency: "EUR",
          access: { locationAccess: { mode: "all", locationIds: [] } },
          tenant: { modules: { memberships: true } },
        }),
      "Workspace currency changed after validation.",
    ],
  ])(
    "does not write after the %s guard changes inside the transaction",
    async (_guard, transactionResult, message) => {
      mocks.loadGuard
        .mockResolvedValueOnce({
          currency: "CZK",
          access: { locationAccess: { mode: "all", locationIds: [] } },
          tenant: { modules: { memberships: true } },
        })
        .mockImplementationOnce(transactionResult);

      await expect(executeRow()(rowArgs())).rejects.toThrow(message);

      expect(mocks.userFindOne).not.toHaveBeenCalled();
      expect(mocks.membershipCreate).not.toHaveBeenCalled();
    },
  );

  it("fails when the published plan version disappears after validation", async () => {
    mocks.versionFindOne.mockReturnValue(leanSessionQuery(null));

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "The published membership plan version is no longer available.",
    );

    expect(mocks.membershipCreate).not.toHaveBeenCalled();
  });

  it("fails when a selected location is no longer offered by the plan", async () => {
    mocks.versionFindOne.mockReturnValue(
      leanSessionQuery(
        versionRecord({
          locationScope: {
            type: "selected",
            locationIds: ["64f64f64f64f64f64f64f640"],
          },
        }),
      ),
    );

    await expect(
      executeRow()(
        rowArgs({ value: normalized({ selectedLocationId: locationId }) }),
      ),
    ).rejects.toThrow(
      "The selected membership location is no longer offered by the plan.",
    );

    expect(mocks.membershipCreate).not.toHaveBeenCalled();
  });

  it("rejects a stale update preview", async () => {
    const outer = existingMembership();
    const current = existingMembership({
      updatedAt: new Date("2026-08-02T12:01:00.000Z"),
    });
    mocks.membershipFind
      .mockReturnValueOnce(membershipQuery([outer]))
      .mockReturnValueOnce(membershipQuery([current]));

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({ expectedUpdatedAt: updatedAt.toISOString() }),
          duplicate: { existingRecordId: outer._id },
        }),
      ),
    ).rejects.toThrow("Membership changed after validation. Validate again.");

    expect(mocks.appendAdjustment).not.toHaveBeenCalled();
  });

  it("fails closed on a pre-existing legacy User membership-credit mirror", async () => {
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, membershipCredits: 3 }),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "The customer has an unreconciled legacy membership-credit balance.",
    );

    expect(mocks.membershipCreate).not.toHaveBeenCalled();
    expect(mocks.appendAdjustment).not.toHaveBeenCalled();
  });

  it("fails closed when an import-owned allowance lacks a canonical balance", async () => {
    const current = existingMembership();
    mocks.membershipFind.mockReturnValue(membershipQuery([current]));
    mocks.balanceFind.mockReturnValue(balanceQuery([]));
    mocks.ledgerFind.mockReturnValue(ledgerQuery([]));
    mocks.userFindOne.mockReturnValue(
      userQuery({ _id: customerId, membershipCredits: 0 }),
    );

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({ expectedUpdatedAt: updatedAt.toISOString() }),
          duplicate: { existingRecordId: current._id },
        }),
      ),
    ).rejects.toThrow(
      "Imported membership allowance credits lacks provenance or a balance.",
    );

    expect(mocks.appendAdjustment).not.toHaveBeenCalled();
    expect(current.save).not.toHaveBeenCalled();
  });

  it("contains no payment, invoice creation, or notification execution path", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/modules/data-import/services/membership-import-execution.service.ts",
      ),
      "utf8",
    );

    expect(source).not.toMatch(/membership\.stripe\.gateway/);
    expect(source).not.toMatch(/membership-notification/);
    expect(source).not.toMatch(/MembershipInvoiceModel\.create/);
    expect(source).not.toMatch(/OrderModel\.create/);
  });
});
