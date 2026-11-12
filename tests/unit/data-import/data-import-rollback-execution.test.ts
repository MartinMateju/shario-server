import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingModel: {
    findOne: vi.fn(),
    exists: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  couponModel: {
    findOne: vi.fn(),
    exists: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  balanceModel: { find: vi.fn() },
  invoiceModel: { exists: vi.fn() },
  planModel: { findOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() },
  planVersionModel: {
    findOne: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  membershipModel: {
    findOne: vi.fn(),
    exists: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  creditAllocationModel: {
    findOne: vi.fn(),
    exists: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  moneyCreditModel: { findOne: vi.fn(), exists: vi.fn() },
  orderModel: { exists: vi.fn() },
  productModel: {
    findOne: vi.fn(),
    exists: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  tenantMembershipModel: { exists: vi.fn() },
  userModel: { findOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() },
  mutationModel: { find: vi.fn(), updateMany: vi.fn(), aggregate: vi.fn() },
  rowModel: { find: vi.fn(), updateMany: vi.fn() },
  sessionModel: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
  audit: vi.fn(),
  assertCommerceReady: vi.fn(),
  resolveAccess: vi.fn(),
  hasPermission: vi.fn(),
  tenantHasModule: vi.fn(),
  appendMembershipAdjustment: vi.fn(),
  terminalizeMembership: vi.fn(),
  changeBalance: vi.fn(),
  startSession: vi.fn(),
  tenantDocument: vi.fn(),
  voucherTenantLock: vi.fn(),
  assertVoucherPublicationAllowed: vi.fn(),
}));

vi.mock("@/modules/product/voucher-offering.policy.js", () => ({
  acquireVoucherTenantMutationLock: mocks.voucherTenantLock,
  assertVoucherOfferingPublicationAllowed:
    mocks.assertVoucherPublicationAllowed,
}));

vi.mock("mongoose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongoose")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      Types: actual.default.Types,
      startSession: mocks.startSession,
      connection: {
        db: { collection: () => ({ findOne: mocks.tenantDocument }) },
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
  () => ({ default: mocks.balanceModel }),
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
vi.mock(
  "../../../src/modules/data-import/data-import-mutation.model.js",
  () => ({ default: mocks.mutationModel }),
);
vi.mock("../../../src/modules/data-import/data-import-row.model.js", () => ({
  default: mocks.rowModel,
}));
vi.mock(
  "../../../src/modules/data-import/data-import-session.model.js",
  () => ({ default: mocks.sessionModel }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-audit.service.js",
  () => ({
    recordDataImportAudit: mocks.audit,
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/commerce-import-readiness.service.js",
  () => ({ assertCommerceImportReady: mocks.assertCommerceReady }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import.service.js",
  () => ({
    getTenantImportSession: vi.fn(),
    serializeImportSession: vi.fn((value) => value),
  }),
);

import {
  DATA_IMPORT_MUTATION_ROLLBACK_STATUS,
  DATA_IMPORT_ROLLBACK_STATUS,
} from "../../../src/modules/data-import/data-import.constants.js";
import { processImportRollbackSession } from "../../../src/modules/data-import/services/data-import-rollback.service.js";

const TENANT = "507f1f77bcf86cd799439012";
const SESSION = "507f1f77bcf86cd799439011";
const ACTOR = "507f1f77bcf86cd799439099";
const emptyHash = createHash("sha256")
  .update(JSON.stringify({ present: [], values: {} }))
  .digest("hex");

const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
};

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["select", "sort", "session", "limit"])
    chain[method] = vi.fn(() => chain);
  chain.lean = vi.fn(async () => value);
  chain.exec = vi.fn(async () => value);
  chain.then = (
    resolve: (result: T) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
};

type ScenarioMutation = ReturnType<typeof mutation>;
let scenario: {
  entityType: string;
  mutations: ScenarioMutation[];
  rows: any[];
  targets: Map<string, any>;
  session: any;
};
let transactions: any[];

const mutation = ({
  id,
  rowId,
  rowNumber = 2,
  target,
  entityType,
  operation = "create",
  importOutcome = "created",
  canonical = true,
  rollbackStatus = DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PENDING,
  delta = {},
}: {
  id: string;
  rowId: string;
  rowNumber?: number;
  target: string;
  entityType: string;
  operation?: "create" | "update" | "delta";
  importOutcome?: "created" | "updated";
  canonical?: boolean;
  rollbackStatus?: string;
  delta?: Record<string, unknown>;
}) => {
  const entry = {
    _id: id,
    schemaVersion: 1,
    tenant: TENANT,
    session: SESSION,
    row: rowId,
    mutationKey: `mutation:${id}`,
    rowNumber,
    entityType,
    operation,
    importOutcome,
    importMessage: "Imported",
    isCanonicalResult: canonical,
    target,
    targetUpdatedAt: null,
    affectedFields: [] as string[],
    before: { values: {} as Record<string, unknown>, present: [] as string[] },
    after: { values: {} as Record<string, unknown>, present: [] as string[] },
    afterHash: emptyHash,
    payloadHash: "",
    delta,
    actor: ACTOR,
    rollback: { status: rollbackStatus } as Record<string, any>,
  };
  rehashMutation(entry);
  return entry;
};

const rehashMutation = (entry: any): void => {
  entry.afterHash = createHash("sha256")
    .update(JSON.stringify(canonical(entry.after)))
    .digest("hex");
  entry.payloadHash = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          schemaVersion: 1,
          tenant: String(entry.tenant),
          session: String(entry.session),
          row: entry.row,
          mutationKey: entry.mutationKey,
          rowNumber: Number(entry.rowNumber),
          entityType: entry.entityType,
          operation: entry.operation,
          importOutcome: entry.importOutcome,
          importMessage: entry.importMessage,
          isCanonicalResult: Boolean(entry.isCanonicalResult),
          targetId: String(entry.target),
          targetUpdatedAt: entry.targetUpdatedAt
            ? new Date(entry.targetUpdatedAt).toISOString()
            : null,
          fields: [...entry.affectedFields],
          before: entry.before,
          after: entry.after,
          delta: entry.delta ?? null,
          actorId: String(entry.actor),
        }),
      ),
    )
    .digest("hex");
};

const targetFor = (filter: any) =>
  scenario.targets.get(String(filter?._id)) || null;

const configureScenario = ({
  entityType,
  mutations,
  targets,
}: {
  entityType: string;
  mutations: ScenarioMutation[];
  targets: Record<string, any>;
}) => {
  const canonical = mutations.filter((entry) => entry.isCanonicalResult);
  const rows = canonical.map((entry) => ({
    _id: entry.row,
    rowNumber: entry.rowNumber,
    status: entry.importOutcome,
    ...(entityType === "customers"
      ? { resultUser: entry.target }
      : { resultRecord: entry.target }),
  }));
  scenario = {
    entityType,
    mutations,
    rows,
    targets: new Map(Object.entries(targets)),
    session: {
      _id: SESSION,
      tenant: TENANT,
      entityType,
      status: "completed",
      createdBy: ACTOR,
      summary: {
        total: rows.length,
        created: rows.filter((entry) => entry.status === "created").length,
        updated: rows.filter((entry) => entry.status === "updated").length,
      },
      rollback: {
        status: "queued",
        revision: 5,
        requestedBy: ACTOR,
      },
    },
  };
};

const updateMatchingJournals = (filter: any, update: any) => {
  const ids = new Set((filter?._id?.$in || []).map(String));
  for (const entry of scenario.mutations) {
    if (filter?.row && String(filter.row) !== String(entry.row)) continue;
    if (ids.size && !ids.has(String(entry._id))) continue;
    const excluded = filter?.["rollback.status"]?.$ne;
    if (excluded && entry.rollback.status === excluded) continue;
    const exact =
      typeof filter?.["rollback.status"] === "string"
        ? filter["rollback.status"]
        : null;
    if (exact && entry.rollback.status !== exact) continue;
    for (const [path, value] of Object.entries(update?.$set || {})) {
      if (path === "rollback.status") entry.rollback.status = String(value);
      else if (path.startsWith("rollback."))
        (entry.rollback as any)[path.slice("rollback.".length)] = value;
      else (entry as any)[path] = value;
    }
  }
  return { matchedCount: 1 };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.voucherTenantLock.mockResolvedValue({ settings: { timezone: "UTC" } });
  mocks.assertVoucherPublicationAllowed.mockResolvedValue(undefined);
  transactions = [];
  mocks.startSession.mockImplementation(async () => {
    const tx = {
      id: `tx-${transactions.length + 1}`,
      withTransaction: vi.fn(async (callback: () => Promise<void>) =>
        callback(),
      ),
      endSession: vi.fn(),
    };
    transactions.push(tx);
    return tx;
  });
  mocks.resolveAccess.mockResolvedValue({ status: "active" });
  mocks.hasPermission.mockReturnValue(true);
  mocks.tenantDocument.mockResolvedValue({ modules: {} });
  mocks.tenantHasModule.mockReturnValue(true);
  mocks.assertCommerceReady.mockResolvedValue(undefined);
  mocks.sessionModel.findOne.mockImplementation(() => query(scenario.session));
  mocks.sessionModel.findOneAndUpdate.mockImplementation(() =>
    query(scenario.session),
  );
  mocks.sessionModel.updateOne.mockResolvedValue({ matchedCount: 1 });
  mocks.mutationModel.find.mockImplementation((filter: any) => {
    const entries = filter?.isCanonicalResult
      ? scenario.mutations.filter((entry) => entry.isCanonicalResult)
      : filter?.row
        ? scenario.mutations.filter(
            (entry) => String(entry.row) === String(filter.row),
          )
        : [...scenario.mutations];
    const result = query(entries);
    result.sort.mockImplementation((sort: Record<string, number>) => {
      if (sort?.isCanonicalResult) {
        entries.sort(
          (left, right) =>
            Number(right.isCanonicalResult) - Number(left.isCanonicalResult),
        );
      }
      return result;
    });
    return result;
  });
  mocks.mutationModel.aggregate.mockImplementation(async () => {
    const byRow = new Map<string, number>();
    for (const entry of scenario.mutations)
      byRow.set(
        String(entry.row),
        Math.max(byRow.get(String(entry.row)) || 0, entry.rowNumber),
      );
    return [...byRow.entries()]
      .map(([row, rowNumber]) => ({ row, rowNumber }))
      .sort((left, right) => right.rowNumber - left.rowNumber);
  });
  mocks.mutationModel.updateMany.mockImplementation(updateMatchingJournals);
  mocks.rowModel.find.mockImplementation(() => query(scenario.rows));
  mocks.rowModel.updateMany.mockResolvedValue({ matchedCount: 1 });
  for (const model of [
    mocks.bookingModel,
    mocks.couponModel,
    mocks.planModel,
    mocks.planVersionModel,
    mocks.membershipModel,
    mocks.creditAllocationModel,
    mocks.moneyCreditModel,
    mocks.productModel,
    mocks.userModel,
  ] as any[]) {
    model.findOne?.mockImplementation((filter: any) =>
      query(targetFor(filter)),
    );
    model.updateOne?.mockResolvedValue({ matchedCount: 1 });
    model.deleteOne?.mockResolvedValue({ deletedCount: 1 });
  }
  for (const model of [
    mocks.bookingModel,
    mocks.couponModel,
    mocks.invoiceModel,
    mocks.membershipModel,
    mocks.creditAllocationModel,
    mocks.moneyCreditModel,
    mocks.orderModel,
    mocks.productModel,
    mocks.tenantMembershipModel,
  ])
    model.exists?.mockReturnValue(query(null));
  mocks.balanceModel.find.mockReturnValue(query([]));
});

const run = () =>
  processImportRollbackSession({
    tenantId: TENANT,
    sessionId: SESSION,
    revision: 5,
  });

const expectNoHardDeletes = () => {
  for (const model of [
    mocks.bookingModel,
    mocks.couponModel,
    mocks.planModel,
    mocks.planVersionModel,
    mocks.membershipModel,
    mocks.creditAllocationModel,
    mocks.productModel,
    mocks.userModel,
  ])
    expect(model.deleteOne).not.toHaveBeenCalled();
};

describe("grouped data import rollback execution", () => {
  it("preflights a plan and version as one row and compensates them in one transaction", async () => {
    const plan = "507f1f77bcf86cd799439041";
    const version = "507f1f77bcf86cd799439042";
    configureScenario({
      entityType: "membership-plans",
      mutations: [
        mutation({
          id: "plan-journal",
          rowId: "row-a",
          target: plan,
          entityType: "membership-plans",
          delta: { kind: "membership_plan", createdVersionId: version },
        }),
        mutation({
          id: "version-journal",
          rowId: "row-a",
          target: version,
          entityType: "membership-plans",
          canonical: false,
          delta: { kind: "membership_plan_version", planId: plan },
        }),
      ],
      targets: {
        [plan]: { _id: plan, tenant: TENANT, updatedAt: new Date() },
        [version]: { _id: version, tenant: TENANT, updatedAt: new Date() },
      },
    });

    const result = await run();

    expect(result).toMatchObject({
      status: "completed",
      rolledBack: 1,
      archived: 1,
    });
    expect(mocks.planModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: plan, tenant: TENANT }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "archived" }),
      }),
      expect.objectContaining({ session: transactions[0] }),
    );
    expect(mocks.planVersionModel.updateOne).not.toHaveBeenCalled();
    const compensatedCall = mocks.mutationModel.updateMany.mock.calls.find(
      ([, update]) =>
        update?.$set?.["rollback.status"] ===
        DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
    );
    expect(compensatedCall?.[0]._id.$in).toEqual([
      "plan-journal",
      "version-journal",
    ]);
    expect(compensatedCall?.[2]).toEqual({ session: transactions[0] });
    expectNoHardDeletes();
  });

  it("does not mutate either half when a grouped plan row is blocked", async () => {
    const plan = "507f1f77bcf86cd799439041";
    const version = "507f1f77bcf86cd799439042";
    configureScenario({
      entityType: "membership-plans",
      mutations: [
        mutation({
          id: "plan-journal",
          rowId: "row-a",
          target: plan,
          entityType: "membership-plans",
          delta: { kind: "membership_plan", createdVersionId: version },
        }),
        mutation({
          id: "version-journal",
          rowId: "row-a",
          target: version,
          entityType: "membership-plans",
          canonical: false,
          delta: { kind: "membership_plan_version", planId: plan },
        }),
      ],
      targets: {
        [plan]: { _id: plan, tenant: TENANT, updatedAt: new Date() },
        [version]: { _id: version, tenant: TENANT, updatedAt: new Date() },
      },
    });
    mocks.membershipModel.exists.mockReturnValueOnce(
      query({ _id: "dependent" }),
    );

    await expect(run()).resolves.toMatchObject({
      status: DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
      rolledBack: 0,
      blocked: 1,
    });
    expect(mocks.planModel.updateOne).not.toHaveBeenCalled();
    expect(mocks.planVersionModel.updateOne).not.toHaveBeenCalled();
    expectNoHardDeletes();
  });

  it("frees the canonical customer number before restoring a displaced owner", async () => {
    const importedCustomer = "507f1f77bcf86cd799439043";
    const displacedCustomer = "507f1f77bcf86cd799439044";
    const imported = mutation({
      id: "customer-create-journal",
      rowId: "row-a",
      target: importedCustomer,
      entityType: "customers",
    });
    imported.affectedFields = ["memberNumber", "memberNumberHistory"];
    imported.after = {
      values: { memberNumber: 5, memberNumberHistory: [] },
      present: ["memberNumber", "memberNumberHistory"],
    };
    rehashMutation(imported);

    const historyAfter = [
      {
        number: 5,
        reason: "customer_import_conflict",
      },
    ];
    const displacement = mutation({
      id: "customer-displacement-journal",
      rowId: "row-a",
      target: displacedCustomer,
      entityType: "customers",
      operation: "update",
      importOutcome: "updated",
      canonical: false,
      delta: {
        kind: "customer_member_number_displacement",
        importedCustomerId: importedCustomer,
        requestedMemberNumber: 5,
        replacementMemberNumber: 7,
      },
    });
    displacement.affectedFields = ["memberNumber", "memberNumberHistory"];
    displacement.before = {
      values: { memberNumber: 5, memberNumberHistory: [] },
      present: ["memberNumber", "memberNumberHistory"],
    };
    displacement.after = {
      values: { memberNumber: 7, memberNumberHistory: historyAfter },
      present: ["memberNumber", "memberNumberHistory"],
    };
    rehashMutation(displacement);

    configureScenario({
      entityType: "customers",
      // Deliberately reverse the stored order; the rollback query must sort
      // the canonical mutation first to release #5 before restoring it.
      mutations: [displacement, imported],
      targets: {
        [importedCustomer]: {
          _id: importedCustomer,
          tenant: TENANT,
          memberNumber: 5,
          memberNumberHistory: [],
          refreshToken: [],
        },
        [displacedCustomer]: {
          _id: displacedCustomer,
          tenant: TENANT,
          memberNumber: 7,
          memberNumberHistory: historyAfter,
          refreshToken: [],
        },
      },
    });

    await expect(run()).resolves.toMatchObject({
      status: "completed",
      rolledBack: 1,
    });

    expect(
      mocks.userModel.updateOne.mock.calls.map(([filter]) => filter._id),
    ).toEqual([importedCustomer, displacedCustomer]);
    expect(mocks.userModel.updateOne.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        $unset: expect.objectContaining({
          memberNumber: 1,
          memberNumberHistory: 1,
        }),
      }),
    );
    expect(mocks.userModel.updateOne.mock.calls[1][1]).toEqual({
      $set: { memberNumber: 5, memberNumberHistory: [] },
    });
  });

  it.each([
    ["customers", mocks.userModel, { isAccessGranted: false }],
    ["products", mocks.productModel, { isActive: false }],
    ["voucher-products", mocks.productModel, { isActive: false }],
    ["bookings", mocks.bookingModel, { status: "cancelled", archive: true }],
    ["vouchers", mocks.couponModel, { isActive: false }],
  ] as const)(
    "soft-compensates a created %s record without deleting it",
    async (entityType, model, expectedSet) => {
      const target = "507f1f77bcf86cd799439050";
      configureScenario({
        entityType,
        mutations: [
          mutation({
            id: `${entityType}-journal`,
            rowId: "row-a",
            target,
            entityType,
          }),
        ],
        targets: {
          [target]: {
            _id: target,
            tenant: TENANT,
            updatedAt: new Date(),
            orders: [],
            capacityReservations: [],
            bookingRefs: [],
            accessCodeDelivery: {},
            refreshToken: [],
          },
        },
      });

      await expect(run()).resolves.toMatchObject({
        status: "completed",
        archived: 1,
      });
      expect(model.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: target, tenant: TENANT }),
        expect.objectContaining({ $set: expect.objectContaining(expectedSet) }),
        expect.objectContaining({ session: expect.anything() }),
      );
      if (["products", "voucher-products"].includes(entityType)) {
        expect(mocks.voucherTenantLock).toHaveBeenCalledWith(
          TENANT,
          transactions[0],
        );
      }
      expectNoHardDeletes();
    },
  );

  it.each([
    ["customers", mocks.userModel, { password: "already-claimed" }, {}],
    ["products", mocks.productModel, { stripeProductId: "prod_live" }, {}],
    ["bookings", mocks.bookingModel, { orders: ["order-a"] }, {}],
    ["vouchers", mocks.couponModel, { reservedAt: new Date() }, {}],
    [
      "memberships",
      mocks.membershipModel,
      { stripe: {}, planVersion: "507f1f77bcf86cd799439058" },
      { transitionedToTerminal: true, allowancePostState: [] },
    ],
  ] as const)(
    "blocks %s compensation after dependent or terminal activity",
    async (entityType, model, targetState, delta) => {
      const target = "507f1f77bcf86cd799439057";
      const entry = mutation({
        id: `${entityType}-dependent-journal`,
        rowId: "row-a",
        target,
        entityType,
        operation: entityType === "memberships" ? "delta" : "create",
        delta: { ...delta },
      });
      configureScenario({
        entityType,
        mutations: [entry],
        targets: {
          [target]: {
            _id: target,
            tenant: TENANT,
            updatedAt: new Date(),
            refreshToken: [],
            orders: [],
            capacityReservations: [],
            bookingRefs: [],
            accessCodeDelivery: {},
            ...targetState,
          },
        },
      });

      await expect(run()).resolves.toMatchObject({
        status: DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
        rolledBack: 0,
        blocked: 1,
      });
      expect(model.updateOne).not.toHaveBeenCalled();
      expectNoHardDeletes();
    },
  );

  it("restores only journaled fields for an updated record", async () => {
    const target = "507f1f77bcf86cd799439060";
    const entry = mutation({
      id: "product-update",
      rowId: "row-a",
      target,
      entityType: "products",
      operation: "update",
      importOutcome: "updated",
    });
    entry.affectedFields = ["name", "description"];
    entry.before = { values: { name: "Before" }, present: ["name"] };
    entry.after = {
      values: { name: "After", description: "Imported" },
      present: ["name", "description"],
    };
    rehashMutation(entry);
    configureScenario({
      entityType: "products",
      mutations: [entry],
      targets: {
        [target]: {
          _id: target,
          tenant: TENANT,
          updatedAt: new Date(),
          name: "After",
          description: "Imported",
        },
      },
    });

    await expect(run()).resolves.toMatchObject({
      status: "completed",
      restored: 1,
    });
    expect(mocks.productModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ name: "After", description: "Imported" }),
      { $set: { name: "Before" }, $unset: { description: 1 } },
      expect.objectContaining({ runValidators: true }),
    );
    expect(mocks.assertVoucherPublicationAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        session: transactions[0],
        desired: expect.objectContaining({ name: "Before" }),
      }),
    );
  });

  it("uses an inverse credit ledger entry and never deletes the allocation", async () => {
    const target = "507f1f77bcf86cd799439070";
    const userId = "507f1f77bcf86cd799439071";
    configureScenario({
      entityType: "credits",
      mutations: [
        mutation({
          id: "credit-journal",
          rowId: "row-a",
          target,
          entityType: "credits",
          operation: "delta",
          delta: {
            amountMinor: 12_500,
            currency: "CZK",
            userId,
            allocationRevision: 4,
            targetAmountMinor: 20_000,
            priorTargetAmountMinor: 7_500,
          },
        }),
      ],
      targets: {
        [target]: { _id: target, tenant: TENANT, updatedAt: new Date() },
        [userId]: { _id: userId, tenant: TENANT, moneyCreditsMinor: 20_000 },
      },
    });
    mocks.moneyCreditModel.findOne.mockReturnValue(
      query({
        tenant: TENANT,
        user: userId,
        currency: "CZK",
        balanceMinor: 20_000,
      }),
    );

    await expect(run()).resolves.toMatchObject({
      status: "completed",
      compensated: 1,
    });
    expect(mocks.changeBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        amountDelta: -125,
        transaction: expect.objectContaining({
          type: "migration_rollback_debit",
          idempotencyKey: "data-import-rollback:credit-journal",
        }),
      }),
    );
    expect(mocks.creditAllocationModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, targetAmountMinor: 20_000 }),
      expect.objectContaining({
        $set: expect.objectContaining({ targetAmountMinor: 7_500 }),
        $inc: { revision: 1 },
      }),
      expect.objectContaining({ session: expect.anything() }),
    );
    expectNoHardDeletes();
  });

  it("blocks inverse credit compensation when the customer already spent imported value", async () => {
    const target = "507f1f77bcf86cd799439073";
    const userId = "507f1f77bcf86cd799439074";
    configureScenario({
      entityType: "credits",
      mutations: [
        mutation({
          id: "credit-spent-journal",
          rowId: "row-a",
          target,
          entityType: "credits",
          operation: "delta",
          delta: {
            amountMinor: 12_500,
            currency: "CZK",
            userId,
            allocationRevision: 1,
            targetAmountMinor: 12_500,
            priorTargetAmountMinor: 0,
          },
        }),
      ],
      targets: {
        [target]: { _id: target, tenant: TENANT, updatedAt: new Date() },
        [userId]: { _id: userId, tenant: TENANT, moneyCreditsMinor: 10_000 },
      },
    });
    mocks.moneyCreditModel.findOne.mockReturnValue(
      query({
        tenant: TENANT,
        user: userId,
        currency: "CZK",
        balanceMinor: 10_000,
      }),
    );

    await expect(run()).resolves.toMatchObject({
      status: DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
      rolledBack: 0,
      blocked: 1,
    });
    expect(mocks.changeBalance).not.toHaveBeenCalled();
    expect(mocks.creditAllocationModel.updateOne).not.toHaveBeenCalled();
  });

  it("reverses membership allowances and terminalizes an import-created membership", async () => {
    const target = "507f1f77bcf86cd799439080";
    const version = "507f1f77bcf86cd799439081";
    configureScenario({
      entityType: "memberships",
      mutations: [
        mutation({
          id: "membership-journal",
          rowId: "row-a",
          target,
          entityType: "memberships",
          operation: "delta",
          delta: {
            createdMembership: true,
            userId: "507f1f77bcf86cd799439082",
            priorTargets: { studio: 2 },
            targetAllowances: { studio: 5 },
            allowancePostState: [],
            periodStart: "2026-08-01T00:00:00.000Z",
            periodEnd: "2026-09-01T00:00:00.000Z",
          },
        }),
      ],
      targets: {
        [target]: {
          _id: target,
          tenant: TENANT,
          updatedAt: new Date(),
          planVersion: version,
          stripe: {},
          isOpen: true,
        },
        [version]: {
          _id: version,
          tenant: TENANT,
          benefits: [{ key: "studio" }],
        },
      },
    });

    await expect(run()).resolves.toMatchObject({
      status: "completed",
      compensated: 1,
    });
    expect(mocks.appendMembershipAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: target,
        delta: -3,
        idempotencyKey: "data-import-rollback:membership-journal:studio",
        session: expect.anything(),
      }),
    );
    expect(mocks.terminalizeMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        session: expect.anything(),
      }),
    );
    expectNoHardDeletes();
  });

  it("retries only uncompensated rows after a partial rollback", async () => {
    const first = "507f1f77bcf86cd799439091";
    const second = "507f1f77bcf86cd799439092";
    configureScenario({
      entityType: "products",
      mutations: [
        mutation({
          id: "already-done",
          rowId: "row-a",
          rowNumber: 2,
          target: first,
          entityType: "products",
          rollbackStatus: "compensated",
        }),
        mutation({
          id: "retry-me",
          rowId: "row-b",
          rowNumber: 3,
          target: second,
          entityType: "products",
        }),
      ],
      targets: {
        [first]: { _id: first, tenant: TENANT, updatedAt: new Date() },
        [second]: { _id: second, tenant: TENANT, updatedAt: new Date() },
      },
    });

    await expect(run()).resolves.toMatchObject({
      status: "completed",
      rolledBack: 2,
    });
    const targetFilters = mocks.productModel.updateOne.mock.calls.map(
      ([filter]) => filter._id,
    );
    expect(targetFilters).toEqual([second]);
  });
});

describe("rollback fencing and authorization durability", () => {
  beforeEach(() => {
    const target = "507f1f77bcf86cd799439050";
    configureScenario({
      entityType: "products",
      mutations: [
        mutation({
          id: "product-journal",
          rowId: "row-a",
          target,
          entityType: "products",
        }),
      ],
      targets: {
        [target]: { _id: target, tenant: TENANT, updatedAt: new Date() },
      },
    });
  });

  it("fails durably and restores TTL when permission is revoked before execution", async () => {
    mocks.hasPermission.mockReturnValue(false);

    await expect(run()).rejects.toThrow("no longer has permission");

    expect(mocks.productModel.updateOne).not.toHaveBeenCalled();
    expect(mocks.sessionModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: SESSION,
        tenant: TENANT,
        "rollback.revision": 5,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.FAILED,
          "rollback.lastError": expect.objectContaining({
            code: "IMPORT_ROLLBACK_ACCESS_REVOKED",
          }),
          rollbackAvailableUntil: expect.any(Date),
          reportAvailableUntil: expect.any(Date),
        }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(mocks.mutationModel.updateMany).toHaveBeenCalledWith(
      { tenant: TENANT, session: SESSION },
      { $set: { expiresAt: expect.any(Date) } },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(mocks.rowModel.updateMany).toHaveBeenCalledWith(
      { tenant: TENANT, session: SESSION },
      { $set: { expiresAt: expect.any(Date) } },
      expect.objectContaining({ session: expect.anything() }),
    );
  });

  it("rechecks permission during heartbeat and performs no business mutation after revocation", async () => {
    let permissionChecks = 0;
    mocks.hasPermission.mockImplementation(() => {
      permissionChecks += 1;
      return permissionChecks <= 3;
    });

    await expect(run()).rejects.toThrow("no longer has permission");

    expect(mocks.productModel.updateOne).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rollback_failed" }),
    );
  });

  it("stops before domain writes when the execution lease is lost", async () => {
    mocks.sessionModel.updateOne.mockImplementation(async (filter: any) => ({
      matchedCount:
        filter?.["rollback.status"] === DATA_IMPORT_ROLLBACK_STATUS.PROCESSING
          ? 0
          : 0,
    }));

    await expect(run()).rejects.toThrow("execution lease was lost");
    expect(mocks.productModel.updateOne).not.toHaveBeenCalled();
    expect(mocks.mutationModel.updateMany).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          "rollback.status": DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
        }),
      }),
      expect.anything(),
    );
  });

  it("fences terminal finalization when another worker steals the claim", async () => {
    mocks.sessionModel.updateOne.mockImplementation(
      async (filter: any, update: any) => {
        const nextStatus = update?.$set?.["rollback.status"];
        if (
          filter?.["rollback.status"] ===
            DATA_IMPORT_ROLLBACK_STATUS.PROCESSING &&
          nextStatus &&
          nextStatus !== DATA_IMPORT_ROLLBACK_STATUS.PROCESSING
        )
          return { matchedCount: 0 };
        if (
          nextStatus === DATA_IMPORT_ROLLBACK_STATUS.FAILED &&
          !filter?.["rollback.status"]
        )
          return { matchedCount: 0 };
        return { matchedCount: 1 };
      },
    );

    await expect(run()).rejects.toThrow("execution lease was lost");

    expect(mocks.productModel.updateOne).toHaveBeenCalledTimes(1);
    const finalization = mocks.sessionModel.updateOne.mock.calls.find(
      ([filter, update]) =>
        filter?.["rollback.status"] ===
          DATA_IMPORT_ROLLBACK_STATUS.PROCESSING &&
        update?.$set?.["rollback.status"] ===
          DATA_IMPORT_ROLLBACK_STATUS.COMPLETED,
    );
    expect(finalization?.[0]).toEqual(
      expect.objectContaining({
        "rollback.claimToken": expect.any(String),
        "rollback.revision": 5,
      }),
    );
  });
});
