import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingModel: { findOne: vi.fn(), exists: vi.fn(), updateOne: vi.fn() },
  couponModel: { findOne: vi.fn(), exists: vi.fn(), updateOne: vi.fn() },
  balanceModel: { find: vi.fn() },
  invoiceModel: { exists: vi.fn() },
  planModel: { findOne: vi.fn(), updateOne: vi.fn() },
  planVersionModel: { findOne: vi.fn(), updateOne: vi.fn() },
  membershipModel: { findOne: vi.fn(), exists: vi.fn(), updateOne: vi.fn() },
  creditAllocationModel: {
    findOne: vi.fn(),
    exists: vi.fn(),
    updateOne: vi.fn(),
  },
  moneyCreditModel: { findOne: vi.fn(), exists: vi.fn() },
  orderModel: { exists: vi.fn() },
  productModel: { findOne: vi.fn(), exists: vi.fn(), updateOne: vi.fn() },
  tenantMembershipModel: { exists: vi.fn() },
  userModel: { findOne: vi.fn(), updateOne: vi.fn() },
  mutationModel: {
    find: vi.fn(),
    findOne: vi.fn(),
    updateMany: vi.fn(),
    aggregate: vi.fn(),
  },
  rowModel: { find: vi.fn(), updateMany: vi.fn() },
  sessionModel: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
  getTenantImportSession: vi.fn(),
  serializeImportSession: vi.fn((value) => value),
  recordAudit: vi.fn(),
  assertCommerceReady: vi.fn(),
  resolveAccess: vi.fn(),
  hasPermission: vi.fn(),
  tenantHasModule: vi.fn(),
  appendMembershipAdjustment: vi.fn(),
  terminalizeMembership: vi.fn(),
  changeBalance: vi.fn(),
  startSession: vi.fn(),
  tenantDocument: vi.fn(),
}));

vi.mock("mongoose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongoose")>();
  const defaultMongoose = actual.default;
  return {
    ...actual,
    default: {
      ...defaultMongoose,
      Types: defaultMongoose.Types,
      startSession: mocks.startSession,
      connection: {
        db: {
          collection: () => ({ findOne: mocks.tenantDocument }),
        },
      },
    },
  };
});

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: mocks.bookingModel,
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: mocks.couponModel,
}));
vi.mock(
  "@/modules/membership/membership-entitlement-balance.schema.js",
  () => ({
    default: mocks.balanceModel,
  }),
);
vi.mock("@/modules/membership/membership-invoice.schema.js", () => ({
  default: mocks.invoiceModel,
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: mocks.planModel,
}));
vi.mock("@/modules/membership/membership-plan-version.model.js", () => ({
  default: mocks.planVersionModel,
}));
vi.mock("@/modules/membership/user-membership.model.js", () => ({
  default: mocks.membershipModel,
}));
vi.mock(
  "@/modules/membership/services/membership-entitlement.service.js",
  () => ({
    appendMembershipImportAdjustment: mocks.appendMembershipAdjustment,
  }),
);
vi.mock(
  "@/modules/membership/services/membership-lifecycle.service.js",
  () => ({
    terminalizeMembership: mocks.terminalizeMembership,
  }),
);
vi.mock("@/modules/money-credit/credit-import-allocation.model.js", () => ({
  default: mocks.creditAllocationModel,
}));
vi.mock("@/modules/money-credit/money-credit.model.js", () => ({
  MoneyCredit: mocks.moneyCreditModel,
}));
vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({
  moneyCreditService: { changeBalance: mocks.changeBalance },
}));
vi.mock("@/modules/order/order.model.js", () => ({
  default: mocks.orderModel,
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: mocks.productModel,
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: mocks.tenantMembershipModel,
}));
vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  resolveWorkspaceAccessForUser: mocks.resolveAccess,
  hasWorkspacePermission: mocks.hasPermission,
}));
vi.mock("@/modules/user/user.model.js", () => ({ default: mocks.userModel }));
vi.mock("@/shared/middleware/tenantFeatures.js", () => ({
  tenantHasModule: mocks.tenantHasModule,
}));
vi.mock("@/shared/http/httpErrors.js", () => ({
  conflict: (input: Record<string, unknown>) => {
    throw Object.assign(new Error(String(input.message || "Conflict")), input);
  },
}));
vi.mock(
  "../../../src/modules/data-import/data-import-mutation.model.js",
  () => ({
    default: mocks.mutationModel,
  }),
);
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
  "../../../src/modules/data-import/services/data-import-audit.service.js",
  () => ({
    recordDataImportAudit: mocks.recordAudit,
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/commerce-import-readiness.service.js",
  () => ({ assertCommerceImportReady: mocks.assertCommerceReady }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import.service.js",
  () => ({
    getTenantImportSession: mocks.getTenantImportSession,
    serializeImportSession: mocks.serializeImportSession,
  }),
);

import {
  DATA_IMPORT_MUTATION_ROLLBACK_STATUS,
  DATA_IMPORT_ROLLBACK_REASON,
} from "../../../src/modules/data-import/data-import.constants.js";
import {
  previewImportRollback,
  queueImportRollbackState,
} from "../../../src/modules/data-import/services/data-import-rollback.service.js";

const future = () => new Date(Date.now() + 86_400_000);

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["select", "sort", "skip", "limit", "session"])
    chain[method] = vi.fn(() => chain);
  chain.lean = vi.fn(async () => value);
  chain.exec = vi.fn(async () => value);
  chain.then = (
    resolve: (result: T) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
};

const completedSession = (
  summary: Record<string, number> = { created: 1, updated: 0 },
) => ({
  _id: "507f1f77bcf86cd799439011",
  tenant: "507f1f77bcf86cd799439012",
  entityType: "credits",
  status: "completed",
  completedAt: new Date("2026-08-01T12:00:00.000Z"),
  rollbackAvailableUntil: future(),
  summary: { total: 1, ...summary },
  rollback: { status: "available", revision: 0 },
});

const row = (
  status: "created" | "updated" = "created",
  id = "507f1f77bcf86cd799439021",
  resultRecord = "507f1f77bcf86cd799439031",
) => ({
  _id: id,
  rowNumber: 2,
  status,
  resultRecord,
});

const emptySnapshotHash = createHash("sha256")
  .update(JSON.stringify({ present: [], values: {} }))
  .digest("hex");

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
};

const mutation = ({
  rowId = "507f1f77bcf86cd799439021",
  target = "507f1f77bcf86cd799439031",
  entityType = "credits",
  importOutcome = "created",
  rollbackStatus = DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PENDING,
  isCanonicalResult = true,
  delta = {},
}: Partial<{
  rowId: string;
  target: string;
  entityType: string;
  importOutcome: "created" | "updated";
  rollbackStatus: string;
  isCanonicalResult: boolean;
  delta: Record<string, unknown>;
}> = {}) => {
  const entry = {
    _id: `${target}-journal`,
    schemaVersion: 1,
    tenant: "507f1f77bcf86cd799439012",
    session: "507f1f77bcf86cd799439011",
    row: rowId,
    mutationKey: `mutation:${rowId}:${target}`,
    rowNumber: 2,
    entityType,
    operation: entityType === "credits" ? "delta" : "create",
    importOutcome,
    importMessage: "Imported",
    isCanonicalResult,
    target,
    targetUpdatedAt: null,
    affectedFields: [] as string[],
    before: { values: {}, present: [] as string[] },
    after: { values: {}, present: [] as string[] },
    afterHash: emptySnapshotHash,
    payloadHash: "",
    delta,
    actor: "507f1f77bcf86cd799439099",
    rollback: { status: rollbackStatus },
  };
  entry.payloadHash = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          schemaVersion: 1,
          tenant: entry.tenant,
          session: entry.session,
          row: entry.row,
          mutationKey: entry.mutationKey,
          rowNumber: entry.rowNumber,
          entityType: entry.entityType,
          operation: entry.operation,
          importOutcome: entry.importOutcome,
          importMessage: entry.importMessage,
          isCanonicalResult: entry.isCanonicalResult,
          targetId: entry.target,
          targetUpdatedAt: null,
          fields: entry.affectedFields,
          before: entry.before,
          after: entry.after,
          delta: entry.delta,
          actorId: entry.actor,
        }),
      ),
    )
    .digest("hex");
  return entry;
};

const arrangePreview = ({
  session = completedSession(),
  mutations = [] as any[],
  rows = [] as any[],
  revision = 1,
} = {}) => {
  mocks.getTenantImportSession.mockResolvedValue(session);
  mocks.mutationModel.find.mockReturnValue(query(mutations));
  mocks.rowModel.find.mockReturnValue(query(rows));
  mocks.sessionModel.findOneAndUpdate.mockReturnValue(
    query({ rollback: { revision } }),
  );
  mocks.sessionModel.findOne.mockReturnValue(query({ rollback: { revision } }));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertCommerceReady.mockResolvedValue(undefined);
  mocks.resolveAccess.mockResolvedValue({ status: "active" });
  mocks.hasPermission.mockReturnValue(true);
  mocks.tenantHasModule.mockReturnValue(true);
  mocks.tenantDocument.mockResolvedValue({ modules: { credits: true } });
  for (const model of [
    mocks.bookingModel,
    mocks.couponModel,
    mocks.invoiceModel,
    mocks.membershipModel,
    mocks.moneyCreditModel,
    mocks.orderModel,
    mocks.productModel,
    mocks.tenantMembershipModel,
  ])
    model.exists?.mockReturnValue(query(null));
  mocks.balanceModel.find.mockReturnValue(query([]));
});

describe("data import rollback preview integrity", () => {
  it("gates a completed legacy import with no mutation journal", async () => {
    arrangePreview({
      session: completedSession(),
      mutations: [],
      rows: [row()],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview.available).toBe(false);
    expect(preview.eligibleRows).toBe(0);
    expect(preview.reasonGroups).toEqual([
      { code: DATA_IMPORT_ROLLBACK_REASON.LEGACY_MANIFEST_MISSING, count: 1 },
    ]);
  });

  it("invalidates the entire preview when a journal row is extra", async () => {
    arrangePreview({
      mutations: [
        mutation(),
        mutation({
          rowId: "507f1f77bcf86cd799439022",
          target: "507f1f77bcf86cd799439032",
        }),
      ],
      rows: [row()],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview).toMatchObject({
      available: false,
      eligibleRows: 0,
      blockedRows: 1,
    });
    expect(preview.reasonGroups[0]?.code).toBe(
      DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
    );
  });

  it("binds the canonical journal target to the immutable row result record", async () => {
    arrangePreview({
      mutations: [mutation({ target: "507f1f77bcf86cd799439031" })],
      rows: [row("created", undefined, "507f1f77bcf86cd799439099")],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview).toMatchObject({ available: false, eligibleRows: 0 });
    expect(preview.reasonGroups[0]?.code).toBe(
      DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
    );
  });

  it("binds a customer journal target to the immutable resultUser field", async () => {
    const entry = mutation({
      entityType: "customers",
      target: "507f1f77bcf86cd799439031",
    });
    arrangePreview({
      session: { ...completedSession(), entityType: "customers" },
      mutations: [entry],
      rows: [
        {
          _id: entry.row,
          rowNumber: 2,
          status: "created",
          resultUser: "507f1f77bcf86cd799439098",
        },
      ],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview.reasonGroups[0]?.code).toBe(
      DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
    );
  });

  it.each(["payloadHash", "afterHash"] as const)(
    "invalidates a row when its signed %s is tampered",
    async (field) => {
      const entry = mutation();
      entry[field] = "0".repeat(64);
      arrangePreview({ mutations: [entry], rows: [row()] });

      const preview = await previewImportRollback({
        tenantId: "507f1f77bcf86cd799439012",
        sessionId: "507f1f77bcf86cd799439011",
      });

      expect(preview).toMatchObject({ available: false, eligibleRows: 0 });
      expect(preview.reasonGroups[0]?.code).toBe(
        DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
      );
    },
  );

  it("requires created and updated manifest counts to match the session summary", async () => {
    arrangePreview({
      session: completedSession({ created: 1, updated: 0 }),
      mutations: [
        mutation({
          importOutcome: "updated",
          rollbackStatus: DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
        }),
      ],
      rows: [row("updated")],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview.reasonGroups[0]?.code).toBe(
      DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
    );
  });

  it("requires a plan-version journal to belong to its canonical plan journal", async () => {
    const planSession = {
      ...completedSession(),
      entityType: "membership-plans",
    };
    arrangePreview({
      session: planSession,
      mutations: [
        mutation({
          entityType: "membership-plans",
          target: "507f1f77bcf86cd799439041",
          rollbackStatus: DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
          delta: {
            kind: "membership_plan",
            createdVersionId: "507f1f77bcf86cd799439051",
          },
        }),
        mutation({
          entityType: "membership-plans",
          target: "507f1f77bcf86cd799439052",
          rollbackStatus: DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
          isCanonicalResult: false,
          delta: {
            kind: "membership_plan_version",
            planId: "507f1f77bcf86cd799439042",
          },
        }),
      ],
      rows: [row()],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview.reasonGroups[0]?.code).toBe(
      DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
    );
  });

  it("counts fully compensated rows separately from eligible rows", async () => {
    arrangePreview({
      mutations: [
        mutation({
          rollbackStatus: DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
        }),
      ],
      rows: [row()],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview).toMatchObject({
      available: false,
      eligibleRows: 0,
      compensatedRows: 1,
      blockedRows: 0,
    });
  });

  it("returns retention-expired for an expired journal rather than treating it as legacy", async () => {
    arrangePreview({
      session: {
        ...completedSession(),
        rollbackAvailableUntil: new Date(Date.now() - 1),
      },
      mutations: [mutation()],
      rows: [row()],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview.reasonGroups).toEqual([
      { code: DATA_IMPORT_ROLLBACK_REASON.RETENTION_EXPIRED, count: 1 },
    ]);
  });

  it("recognizes TTL-purged journals as expired instead of mislabeling them legacy", async () => {
    arrangePreview({
      session: {
        ...completedSession(),
        rollbackAvailableUntil: new Date(Date.now() - 1),
      },
      mutations: [],
      rows: [row()],
    });

    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(preview.reasonGroups).toEqual([
      { code: DATA_IMPORT_ROLLBACK_REASON.RETENTION_EXPIRED, count: 1 },
    ]);
  });

  it("changes the exact preview token when live eligibility changes", async () => {
    const entry = mutation();
    arrangePreview({ mutations: [entry], rows: [row()] });
    mocks.creditAllocationModel.findOne
      .mockReturnValueOnce(
        query({
          _id: entry.target,
          tenant: entry.tenant,
          updatedAt: new Date(),
        }),
      )
      .mockReturnValueOnce(query(null));

    const first = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });
    const second = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });

    expect(first.available).toBe(true);
    expect(second.available).toBe(false);
    expect(first.previewToken).not.toBe(second.previewToken);
  });
});

describe("data import rollback request binding", () => {
  it("rejects a stale preview revision before queue state is mutated", async () => {
    const eligibleMutation = mutation();
    arrangePreview({
      mutations: [eligibleMutation],
      rows: [row()],
      revision: 3,
    });
    mocks.sessionModel.findOne.mockReturnValueOnce(query(null));
    mocks.creditAllocationModel.findOne.mockReturnValue(
      query({
        _id: eligibleMutation.target,
        tenant: eligibleMutation.tenant,
        updatedAt: new Date(),
      }),
    );

    await expect(
      queueImportRollbackState({
        tenantId: "507f1f77bcf86cd799439012",
        sessionId: "507f1f77bcf86cd799439011",
        revision: 2,
        previewToken: "a".repeat(64),
        idempotencyKey: "request-1",
        actorId: "507f1f77bcf86cd799439099",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_ROLLBACK_PREVIEW_STALE" });

    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("returns the existing accepted request for an identical idempotency key", async () => {
    const existing = {
      _id: "507f1f77bcf86cd799439011",
      rollback: {
        status: "queued",
        requestedBy: "507f1f77bcf86cd799439099",
        requestPreviewToken: "b".repeat(64),
      },
    };
    mocks.sessionModel.findOne.mockReturnValue(query(existing));
    mocks.serializeImportSession.mockReturnValue({
      id: "same-request",
      status: "queued",
    });

    await expect(
      queueImportRollbackState({
        tenantId: "507f1f77bcf86cd799439012",
        sessionId: "507f1f77bcf86cd799439011",
        revision: 1,
        previewToken: "b".repeat(64),
        idempotencyKey: "request-1",
        actorId: "507f1f77bcf86cd799439099",
      }),
    ).resolves.toEqual({ id: "same-request", status: "queued" });

    expect(mocks.getTenantImportSession).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("pins row and journal retention in the same transaction that accepts rollback", async () => {
    const entry = mutation();
    arrangePreview({ mutations: [entry], rows: [row()], revision: 4 });
    mocks.creditAllocationModel.findOne.mockReturnValue(
      query({
        _id: entry.target,
        tenant: entry.tenant,
        updatedAt: new Date(),
      }),
    );
    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });
    const transaction = {
      withTransaction: vi.fn(async (callback: () => Promise<void>) =>
        callback(),
      ),
      endSession: vi.fn(),
    };
    mocks.startSession.mockResolvedValue(transaction);
    const queued = {
      ...completedSession(),
      rollback: {
        status: "queued",
        revision: preview.revision + 1,
        requestedBy: "507f1f77bcf86cd799439099",
      },
    };
    mocks.sessionModel.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ rollback: { revision: preview.revision } }));
    mocks.sessionModel.findOneAndUpdate
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(queued));

    await queueImportRollbackState({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
      revision: preview.revision,
      previewToken: preview.previewToken,
      idempotencyKey: "request-pinned",
      actorId: "507f1f77bcf86cd799439099",
    });

    expect(transaction.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.mutationModel.updateMany).toHaveBeenCalledWith(
      {
        tenant: "507f1f77bcf86cd799439012",
        session: queued._id,
      },
      { $set: { expiresAt: null } },
      { session: transaction },
    );
    expect(mocks.rowModel.updateMany).toHaveBeenCalledWith(
      {
        tenant: "507f1f77bcf86cd799439012",
        session: queued._id,
      },
      { $set: { expiresAt: null } },
      { session: transaction },
    );
    expect(transaction.endSession).toHaveBeenCalledTimes(1);
  });

  it("returns the concurrent winner for the same idempotency key after losing the CAS", async () => {
    const entry = mutation();
    arrangePreview({ mutations: [entry], rows: [row()], revision: 6 });
    mocks.creditAllocationModel.findOne.mockReturnValue(
      query({
        _id: entry.target,
        tenant: entry.tenant,
        updatedAt: new Date(),
      }),
    );
    const preview = await previewImportRollback({
      tenantId: "507f1f77bcf86cd799439012",
      sessionId: "507f1f77bcf86cd799439011",
    });
    const transaction = {
      withTransaction: vi.fn(async (callback: () => Promise<void>) =>
        callback(),
      ),
      endSession: vi.fn(),
    };
    mocks.startSession.mockResolvedValue(transaction);
    const winner = {
      ...completedSession(),
      rollback: {
        status: "queued",
        revision: preview.revision + 1,
        requestedBy: "507f1f77bcf86cd799439099",
        requestPreviewToken: preview.previewToken,
      },
    };
    mocks.sessionModel.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ rollback: { revision: preview.revision } }))
      .mockReturnValueOnce(query(winner));
    mocks.sessionModel.findOneAndUpdate
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(null));
    mocks.serializeImportSession.mockReturnValue({
      id: "winner",
      status: "queued",
    });

    await expect(
      queueImportRollbackState({
        tenantId: "507f1f77bcf86cd799439012",
        sessionId: "507f1f77bcf86cd799439011",
        revision: preview.revision,
        previewToken: preview.previewToken,
        idempotencyKey: "same-concurrent-request",
        actorId: "507f1f77bcf86cd799439099",
      }),
    ).resolves.toEqual({ id: "winner", status: "queued" });

    expect(mocks.mutationModel.updateMany).not.toHaveBeenCalled();
    expect(mocks.rowModel.updateMany).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
