import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processStaged: vi.fn((args) => args),
  loadGuard: vi.fn(),
  couponFind: vi.fn(),
  couponFindOne: vi.fn(),
  couponCreate: vi.fn(),
  couponFindOneAndUpdate: vi.fn(),
  productFindOne: vi.fn(),
  userExists: vi.fn(),
  moneyCreditExists: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
  recordMutation: vi.fn(),
  voucherTenantLock: vi.fn(),
}));

vi.mock("@/modules/product/voucher-offering.policy.js", () => ({
  acquireVoucherTenantMutationLock: mocks.voucherTenantLock,
}));

vi.mock(
  "@/modules/data-import/services/staged-import-execution.service.js",
  () => ({ processStagedImportSession: mocks.processStaged }),
);
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: {
    find: mocks.couponFind,
    findOne: mocks.couponFindOne,
    create: mocks.couponCreate,
    findOneAndUpdate: mocks.couponFindOneAndUpdate,
  },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { findOne: mocks.productFindOne },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { exists: mocks.userExists },
}));
vi.mock("@/modules/money-credit/money-credit.model.js", () => ({
  MoneyCredit: { exists: mocks.moneyCreditExists },
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

import { processVoucherImportSession } from "@/modules/data-import/services/voucher-import-execution.service.js";

const tenantId = "64b64b64b64b64b64b64b64b";
const actorId = "64a64a64a64a64a64a64a64a";
const productId = "64d64d64d64d64d64d64d64d";
const customerId = "64c64c64c64c64c64c64c64c";
const sessionId = "session-1";
const updatedAt = new Date("2026-08-01T12:00:00.000Z");

const normalized = (overrides: Record<string, unknown> = {}) => ({
  externalId: "VOUCHER-1",
  promoCode: "GIFT-ABCD",
  productExternalId: "VOUCHER-PRODUCT-1",
  status: "active",
  value: 1000,
  valueMinor: 100_000,
  currency: "CZK",
  expiresAt: "2027-08-01T21:59:59.000Z",
  redeemedAt: "",
  note: "Imported liability",
  productId,
  fingerprint: "f".repeat(64),
  providedFields: [
    "externalId",
    "promoCode",
    "productExternalId",
    "status",
    "value",
    "currency",
    "expiresAt",
    "note",
  ],
  parseErrors: [],
  ...overrides,
});

const couponQuery = (records: any[]) => ({
  select: () => ({
    session: () => ({ lean: () => Promise.resolve(records) }),
  }),
});

const couponFindOneQuery = (record: any) => ({
  select: () => ({ lean: () => Promise.resolve(record) }),
});

const couponUpdateQuery = (record: any) => ({
  select: () => Promise.resolve(record),
});

const productQuery = (
  record: any = { _id: productId, kind: "voucher", type: "coupon" },
) => ({
  select: () => ({
    session: () => ({ lean: () => Promise.resolve(record) }),
  }),
});

const existsQuery = (record: any) => ({
  session: () => Promise.resolve(record),
});

const existingVoucher = (overrides: Record<string, unknown> = {}) => ({
  _id: "voucher-1",
  tenant: tenantId,
  product: productId,
  promoCode: "GIFT-ABCD",
  valueMinorSnapshot: 100_000,
  currencySnapshot: "CZK",
  isActive: true,
  singleUse: true,
  expiresAt: new Date("2027-08-01T21:59:59.000Z"),
  reservedAt: null,
  reservedBy: null,
  reservedOrder: null,
  reservedUntil: null,
  redeemedAt: null,
  redeemedBy: null,
  order: null,
  updatedAt,
  importMetadata: {
    externalId: "VOUCHER-1",
    importKey: "older-session:2",
    fingerprint: "f".repeat(64),
    lastMutationKey: "older-session:2",
    note: "Prior note",
  },
  ...overrides,
});

const executeRow = () => {
  processVoucherImportSession({ tenantId, sessionId });
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

describe("voucher import execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.voucherTenantLock.mockResolvedValue({
      settings: { timezone: "UTC" },
    });
    mocks.processStaged.mockImplementation((args) => args);
    mocks.loadGuard.mockResolvedValue({
      currency: "CZK",
      access: { locationAccess: { mode: "all", locationIds: [] } },
      tenant: { modules: { vouchers: true } },
    });
    mocks.couponFind.mockReturnValue(couponQuery([]));
    mocks.couponFindOne.mockReturnValue(couponFindOneQuery(null));
    mocks.couponCreate.mockResolvedValue([{ _id: "voucher-1" }]);
    mocks.couponFindOneAndUpdate.mockReturnValue(
      couponUpdateQuery({ _id: "voucher-1" }),
    );
    mocks.productFindOne.mockReturnValue(productQuery());
    mocks.userExists.mockReturnValue(existsQuery({ _id: customerId }));
    mocks.moneyCreditExists.mockReturnValue(existsQuery(null));
    mocks.withTransaction.mockImplementation(async (callback) => callback());
    mocks.endSession.mockResolvedValue(undefined);
    mocks.recordMutation.mockResolvedValue({});
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    } as never);
  });

  it("creates an active liability snapshot without reservation, order, or credit side effects", async () => {
    await expect(executeRow()(rowArgs())).resolves.toEqual({
      action: "created",
      recordId: "voucher-1",
      message: "Voucher liability imported.",
    });

    expect(mocks.voucherTenantLock).toHaveBeenCalledWith(
      tenantId,
      expect.objectContaining({
        withTransaction: mocks.withTransaction,
      }),
    );

    expect(mocks.couponCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          product: expect.any(mongoose.Types.ObjectId),
          promoCode: "GIFT-ABCD",
          valueMinorSnapshot: 100_000,
          currencySnapshot: "CZK",
          isActive: true,
          singleUse: true,
          reservedAt: null,
          reservedBy: null,
          reservedOrder: null,
          reservedUntil: null,
          redeemedAt: null,
          redeemedBy: null,
          order: null,
          importMetadata: expect.objectContaining({
            importKey: `${sessionId}:2`,
            lastMutationKey: `${sessionId}:2`,
            note: "Imported liability",
          }),
        }),
      ],
      { session: expect.any(Object) },
    );
    expect(mocks.userExists).not.toHaveBeenCalled();
    expect(mocks.moneyCreditExists).not.toHaveBeenCalled();
  });

  it("creates a redeemed historical liability directly with a tenant-scoped customer", async () => {
    const value = normalized({
      status: "redeemed",
      redeemedAt: "2026-07-01T10:00:00.000Z",
      customerExternalId: "CUSTOMER-1",
      customerId,
      providedFields: [
        "externalId",
        "promoCode",
        "productExternalId",
        "status",
        "value",
        "currency",
        "expiresAt",
        "redeemedAt",
        "customerExternalId",
      ],
    });

    await expect(executeRow()(rowArgs({ value }))).resolves.toMatchObject({
      action: "created",
      recordId: "voucher-1",
    });

    expect(mocks.userExists).toHaveBeenCalledWith({
      _id: customerId,
      tenant: tenantId,
    });
    expect(mocks.couponCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          isActive: false,
          redeemedAt: new Date("2026-07-01T10:00:00.000Z"),
          redeemedBy: expect.any(mongoose.Types.ObjectId),
          order: null,
        }),
      ],
      { session: expect.any(Object) },
    );
    expect(mocks.moneyCreditExists).not.toHaveBeenCalled();
  });

  it("fails before writing when a redeemed customer is no longer tenant-scoped", async () => {
    mocks.userExists.mockReturnValue(existsQuery(null));
    const value = normalized({
      status: "redeemed",
      redeemedAt: "2026-07-01T10:00:00.000Z",
      customerExternalId: "CUSTOMER-1",
      customerId,
    });

    await expect(executeRow()(rowArgs({ value }))).rejects.toThrow(
      "The tenant-scoped redeemed customer is no longer available.",
    );

    expect(mocks.couponCreate).not.toHaveBeenCalled();
  });

  it("requires the native value/currency snapshot backfill before update", async () => {
    mocks.couponFind.mockReturnValue(
      couponQuery([
        existingVoucher({
          valueMinorSnapshot: null,
          currencySnapshot: null,
        }),
      ]),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "Run the voucher value snapshot backfill before updating this legacy voucher.",
    );

    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(mocks.couponFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["product", { product: "64e64e64e64e64e64e64e64e" }],
    ["code", { promoCode: "OTHER-CODE" }],
    ["value", { valueMinorSnapshot: 200_000 }],
    ["currency", { currencySnapshot: "EUR" }],
    [
      "external id",
      {
        importMetadata: {
          externalId: "OTHER-VOUCHER",
          importKey: "older-session:2",
          fingerprint: "f".repeat(64),
        },
      },
    ],
  ])("protects immutable voucher %s identity", async (_field, change) => {
    mocks.couponFind.mockReturnValue(
      couponQuery([existingVoucher(change as Record<string, unknown>)]),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "Voucher immutable identity changed after validation.",
    );

    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(mocks.couponFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("does not resurrect a terminal voucher", async () => {
    const existing = existingVoucher({ isActive: false });
    mocks.couponFind.mockReturnValue(couponQuery([existing]));

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({ expectedUpdatedAt: updatedAt.toISOString() }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).rejects.toThrow("Voucher imports cannot resurrect a terminal voucher.");

    expect(mocks.couponFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "native",
      { importMetadata: null },
      null,
      "Only import-owned vouchers can be updated.",
    ],
    [
      "reserved",
      { reservedAt: updatedAt },
      null,
      "Reserved or ordered vouchers cannot be updated.",
    ],
    [
      "ordered",
      { order: "coupon-order-1" },
      null,
      "Reserved or ordered vouchers cannot be updated.",
    ],
    [
      "credited",
      {},
      { _id: "credit-1" },
      "A voucher linked to a credit transaction cannot be updated.",
    ],
  ])(
    "protects a %s voucher from import updates",
    async (_kind, changes, relatedCredit, message) => {
      const existing = existingVoucher(changes as Record<string, unknown>);
      mocks.couponFind.mockReturnValue(couponQuery([existing]));
      mocks.moneyCreditExists.mockReturnValue(existsQuery(relatedCredit));

      await expect(
        executeRow()(
          rowArgs({
            value: normalized({ expectedUpdatedAt: updatedAt.toISOString() }),
            duplicate: { existingRecordId: existing._id },
          }),
        ),
      ).rejects.toThrow(message);

      expect(mocks.couponFindOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it("patches only provided mutable fields and preserves the original import key", async () => {
    const existing = existingVoucher();
    mocks.couponFind.mockReturnValue(couponQuery([existing]));
    mocks.couponFindOneAndUpdate.mockReturnValue(
      couponUpdateQuery({ _id: existing._id }),
    );

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            note: "Updated note",
            expectedUpdatedAt: updatedAt.toISOString(),
            providedFields: ["note"],
          }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).resolves.toEqual({
      action: "updated",
      recordId: "voucher-1",
      message: "Voucher state updated without financial side effects.",
    });

    const [, update] = mocks.couponFindOneAndUpdate.mock.calls[0];
    expect(update.$set).toMatchObject({
      "importMetadata.importId": sessionId,
      "importMetadata.lastMutationKey": `${sessionId}:2`,
      "importMetadata.note": "Updated note",
    });
    expect(update.$set).not.toHaveProperty("isActive");
    expect(update.$set).not.toHaveProperty("expiresAt");
    expect(update.$set).not.toHaveProperty("redeemedAt");
    expect(update.$set).not.toHaveProperty("redeemedBy");
    expect(update.$set).not.toHaveProperty("importMetadata.importKey");
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
        Promise.reject(new Error("The vouchers module is no longer enabled.")),
      "The vouchers module is no longer enabled.",
    ],
    [
      "currency",
      () =>
        Promise.resolve({
          currency: "EUR",
          access: { locationAccess: { mode: "all", locationIds: [] } },
          tenant: { modules: { vouchers: true } },
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
          tenant: { modules: { vouchers: true } },
        })
        .mockImplementationOnce(transactionResult);

      await expect(executeRow()(rowArgs())).rejects.toThrow(message);

      expect(mocks.productFindOne).not.toHaveBeenCalled();
      expect(mocks.couponCreate).not.toHaveBeenCalled();
      expect(mocks.couponFindOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale validation preview before changing state", async () => {
    const existing = existingVoucher();
    mocks.couponFind
      .mockReturnValueOnce(couponQuery([existing]))
      .mockReturnValueOnce(
        couponQuery([
          existingVoucher({
            updatedAt: new Date("2026-08-01T12:01:00.000Z"),
          }),
        ]),
      );

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({ expectedUpdatedAt: updatedAt.toISOString() }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).rejects.toThrow("Voucher changed after validation. Validate again.");

    expect(mocks.moneyCreditExists).not.toHaveBeenCalled();
    expect(mocks.couponFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("does not create another coupon when row completion retries after commit", async () => {
    let stored: any = null;
    mocks.couponFind.mockImplementation(() =>
      couponQuery(stored ? [stored] : []),
    );
    mocks.couponCreate.mockImplementation(async ([payload]) => {
      stored = { ...payload, _id: "voucher-1", updatedAt: new Date() };
      return [stored];
    });

    const run = executeRow();
    await expect(run(rowArgs())).resolves.toMatchObject({ action: "created" });
    await expect(run(rowArgs())).resolves.toEqual({
      action: "skipped",
      recordId: "voucher-1",
      message: "Voucher row was already applied.",
    });

    expect(mocks.couponCreate).toHaveBeenCalledTimes(1);
    expect(mocks.couponFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts only an identity-exact E11000 replay", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: 11_000,
    });
    mocks.couponCreate.mockRejectedValue(duplicate);
    mocks.couponFindOne.mockReturnValue(
      couponFindOneQuery(
        existingVoucher({
          importMetadata: {
            importKey: `${sessionId}:2`,
            lastMutationKey: `${sessionId}:2`,
            externalId: "VOUCHER-1",
            fingerprint: "f".repeat(64),
          },
        }),
      ),
    );

    await expect(executeRow()(rowArgs())).resolves.toEqual({
      action: "skipped",
      recordId: "voucher-1",
      message: "Voucher row was already applied.",
    });

    expect(mocks.couponCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an E11000 row belongs to another immutable identity", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: 11_000,
    });
    mocks.couponCreate.mockRejectedValue(duplicate);
    mocks.couponFindOne.mockReturnValue(
      couponFindOneQuery(existingVoucher({ valueMinorSnapshot: 200_000 })),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "Voucher immutable identity changed after validation.",
    );

    expect(mocks.couponCreate).toHaveBeenCalledTimes(1);
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });
});
