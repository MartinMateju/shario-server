import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processStaged: vi.fn((args) => args),
  loadGuard: vi.fn(),
  acquireVoucherLock: vi.fn(),
  assertVoucherQuota: vi.fn(),
  productFind: vi.fn(),
  productFindOne: vi.fn(),
  productCreate: vi.fn(),
  productFindOneAndUpdate: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
  recordMutation: vi.fn(),
}));

vi.mock("@/modules/product/voucher-offering.policy.js", () => ({
  acquireVoucherTenantMutationLock: mocks.acquireVoucherLock,
  assertVoucherOfferingPublicationAllowed: mocks.assertVoucherQuota,
}));

vi.mock(
  "@/modules/data-import/services/staged-import-execution.service.js",
  () => ({ processStagedImportSession: mocks.processStaged }),
);
vi.mock("@/modules/product/product.model.js", () => ({
  default: {
    find: mocks.productFind,
    findOne: mocks.productFindOne,
    create: mocks.productCreate,
    findOneAndUpdate: mocks.productFindOneAndUpdate,
  },
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

import { processVoucherProductImportSession } from "@/modules/data-import/services/voucher-product-import-execution.service.js";
import { DEFAULT_VOUCHER_DESIGN } from "@/modules/coupon/voucher-design.js";

const tenantId = "64b64b64b64b64b64b64b64b";
const actorId = "64a64a64a64a64a64a64a64a";
const sessionId = "session-1";

const normalized = (overrides: Record<string, unknown> = {}) => ({
  externalId: "VOUCHER-PRODUCT-1",
  name: "Gift Voucher 1000",
  description: "Imported voucher",
  sku: "GIFT-1000",
  value: 1000,
  currency: "CZK",
  isActive: false,
  sortOrder: 10,
  fingerprint: "f".repeat(64),
  providedFields: [
    "externalId",
    "name",
    "description",
    "sku",
    "value",
    "currency",
    "isActive",
    "sortOrder",
  ],
  parseErrors: [],
  ...overrides,
});

const productQuery = (records: any[]) => ({
  select: () => ({
    session: () => ({ lean: () => Promise.resolve(records) }),
  }),
});

const productFindOneQuery = (record: any) => ({
  select: () => ({ lean: () => Promise.resolve(record) }),
});

const productUpdateQuery = (record: any) => ({
  select: () => Promise.resolve(record),
});

const executeRow = () => {
  processVoucherProductImportSession({ tenantId, sessionId });
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

describe("voucher-product import execution", () => {
  beforeEach(() => {
    mocks.acquireVoucherLock.mockResolvedValue({ plan: "starter", voucherQuotaVersion: 1 });
    mocks.assertVoucherQuota.mockResolvedValue(undefined);
    vi.clearAllMocks();
    mocks.processStaged.mockImplementation((args) => args);
    mocks.loadGuard.mockResolvedValue({
      currency: "CZK",
      access: { locationAccess: { mode: "all", locationIds: [] } },
      tenant: { modules: { vouchers: true } },
    });
    mocks.productFind.mockReturnValue(productQuery([]));
    mocks.productFindOne.mockReturnValue(productFindOneQuery(null));
    mocks.productCreate.mockResolvedValue([{ _id: "product-1" }]);
    mocks.productFindOneAndUpdate.mockReturnValue(
      productUpdateQuery({ _id: "product-1" }),
    );
    mocks.withTransaction.mockImplementation(async (callback) => callback());
    mocks.endSession.mockResolvedValue(undefined);
    mocks.recordMutation.mockResolvedValue({});
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    } as never);
  });

  it("creates a canonical inactive Voucher product without delivery or payment state", async () => {
    await expect(executeRow()(rowArgs())).resolves.toEqual({
      action: "created",
      recordId: "product-1",
      message: "Voucher product imported inactive.",
    });

    expect(mocks.productCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: "coupon",
          kind: "voucher",
          kindContractVersion: 2,
          bookingMode: null,
          price: 1000,
          currency: "CZK",
          voucherTemplate: "",
          couponProduct: null,
          isActive: false,
          importMetadata: expect.objectContaining({
            importKey: `${sessionId}:2`,
            lastMutationKey: `${sessionId}:2`,
            externalId: "VOUCHER-PRODUCT-1",
          }),
        }),
      ],
      { session: expect.any(Object) },
    );
    const payload = mocks.productCreate.mock.calls[0][0][0];
    expect(payload).not.toHaveProperty("stripeProductId");
    expect(payload).not.toHaveProperty("stripePriceId");
    expect(payload).not.toHaveProperty("order");
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("upgrades an import-owned legacy coupon while preserving its import key", async () => {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    const existing = {
      _id: "product-1",
      type: "coupon",
      name: "Gift Voucher 1000",
      description: "Old description",
      sku: "GIFT-1000",
      price: 1000,
      currency: "CZK",
      isActive: false,
      updatedAt,
      importMetadata: {
        externalId: "VOUCHER-PRODUCT-1",
        importKey: "older-session:2",
        fingerprint: "f".repeat(64),
        lastMutationKey: "older-session:2",
      },
    };
    mocks.productFind.mockReturnValue(productQuery([existing]));
    mocks.productFindOneAndUpdate.mockReturnValue(
      productUpdateQuery({ _id: existing._id }),
    );

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            description: "New description",
            providedFields: ["description"],
            expectedUpdatedAt: updatedAt.toISOString(),
          }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).resolves.toMatchObject({ action: "updated", recordId: "product-1" });

    const [, update] = mocks.productFindOneAndUpdate.mock.calls[0];
    expect(update.$set).toMatchObject({
      type: "coupon",
      kind: "voucher",
      kindContractVersion: 2,
      bookingMode: null,
      description: "New description",
      "importMetadata.importId": sessionId,
      "importMetadata.lastMutationKey": `${sessionId}:2`,
    });
    expect(update.$set).not.toHaveProperty("name");
    expect(update.$set).not.toHaveProperty("price");
    expect(update.$set).not.toHaveProperty("currency");
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

      expect(mocks.productCreate).not.toHaveBeenCalled();
      expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mocks.endSession).toHaveBeenCalledTimes(1);
    },
  );

  it("requires a configured voucher design or PDF template before activation", async () => {
    await expect(
      executeRow()(rowArgs({ value: normalized({ isActive: true }) })),
    ).rejects.toThrow(
      "Configure a voucher design or PDF template before activating this voucher product.",
    );

    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("activates a designed voucher without a PDF and preserves its design", async () => {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    const existing = {
      _id: "product-1",
      type: "coupon",
      kind: "voucher",
      name: "Gift Voucher 1000",
      price: 1000,
      currency: "CZK",
      isActive: false,
      voucherTemplate: "",
      voucherDesign: DEFAULT_VOUCHER_DESIGN,
      updatedAt,
      importMetadata: {
        externalId: "VOUCHER-PRODUCT-1",
        importKey: "older-session:2",
        lastMutationKey: "older-session:2",
      },
    };
    mocks.productFind.mockReturnValue(productQuery([existing]));

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            isActive: true,
            providedFields: ["isActive"],
            expectedUpdatedAt: updatedAt.toISOString(),
          }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).resolves.toMatchObject({ action: "updated", recordId: "product-1" });

    const [, update] = mocks.productFindOneAndUpdate.mock.calls[0];
    expect(update.$set.isActive).toBe(true);
    expect(update.$set).not.toHaveProperty("voucherDesign");
    expect(update.$set).not.toHaveProperty("voucherTemplate");
    expect(mocks.acquireVoucherLock).toHaveBeenCalled();
    expect(mocks.assertVoucherQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        current: existing,
        desired: { kind: "voucher", isActive: true },
      }),
    );
  });

  it("rejects an incomplete design without a PDF at execution time", async () => {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    const existing = {
      _id: "product-1",
      type: "coupon",
      kind: "voucher",
      voucherTemplate: "",
      voucherDesign: { version: 1, layout: "split" },
      isActive: false,
      updatedAt,
      importMetadata: { externalId: "VOUCHER-PRODUCT-1" },
    };
    mocks.productFind.mockReturnValue(productQuery([existing]));

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            isActive: true,
            providedFields: ["isActive"],
            expectedUpdatedAt: updatedAt.toISOString(),
          }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).rejects.toThrow("Configure a voucher design or PDF template");
    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("protects Stripe-linked value and currency snapshots", async () => {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    const existing = {
      _id: "product-1",
      kind: "voucher",
      type: "coupon",
      name: "Gift Voucher 1000",
      sku: "GIFT-1000",
      price: 1000,
      currency: "CZK",
      isActive: false,
      stripeProductId: "prod_live",
      stripePriceId: "price_live",
      updatedAt,
      importMetadata: {
        externalId: "VOUCHER-PRODUCT-1",
        importKey: "older-session:2",
        fingerprint: "f".repeat(64),
        lastMutationKey: "older-session:2",
      },
    };
    mocks.productFind.mockReturnValue(productQuery([existing]));

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            value: 1200,
            providedFields: ["value"],
            expectedUpdatedAt: updatedAt.toISOString(),
          }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).rejects.toThrow(
      "Stripe-linked voucher value or currency cannot be changed.",
    );

    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("fails closed when the validated external identity changes", async () => {
    mocks.productFind.mockReturnValue(
      productQuery([
        {
          _id: "product-1",
          kind: "voucher",
          type: "coupon",
          importMetadata: {
            externalId: "OTHER-PRODUCT",
            fingerprint: "f".repeat(64),
          },
        },
      ]),
    );

    await expect(executeRow()(rowArgs())).rejects.toThrow(
      "Voucher product external identity changed after validation.",
    );

    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(mocks.productCreate).not.toHaveBeenCalled();
  });

  it("rejects a stale validation preview before applying its patch", async () => {
    const previewUpdatedAt = new Date("2026-08-01T12:00:00.000Z");
    const base = {
      _id: "product-1",
      kind: "voucher",
      type: "coupon",
      name: "Gift Voucher 1000",
      sku: "GIFT-1000",
      price: 1000,
      currency: "CZK",
      isActive: false,
      importMetadata: {
        externalId: "VOUCHER-PRODUCT-1",
        importKey: "older-session:2",
        fingerprint: "f".repeat(64),
        lastMutationKey: "older-session:2",
      },
    };
    mocks.productFind
      .mockReturnValueOnce(
        productQuery([{ ...base, updatedAt: previewUpdatedAt }]),
      )
      .mockReturnValueOnce(
        productQuery([
          {
            ...base,
            updatedAt: new Date("2026-08-01T12:01:00.000Z"),
          },
        ]),
      );

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({
            expectedUpdatedAt: previewUpdatedAt.toISOString(),
          }),
          duplicate: { existingRecordId: base._id },
        }),
      ),
    ).rejects.toThrow(
      "Voucher product changed after validation. Validate again.",
    );

    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects an update compare-and-set race", async () => {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    const existing = {
      _id: "product-1",
      kind: "voucher",
      type: "coupon",
      name: "Gift Voucher 1000",
      sku: "GIFT-1000",
      price: 1000,
      currency: "CZK",
      isActive: false,
      updatedAt,
      importMetadata: {
        externalId: "VOUCHER-PRODUCT-1",
        importKey: "older-session:2",
        fingerprint: "f".repeat(64),
        lastMutationKey: "older-session:2",
      },
    };
    mocks.productFind.mockReturnValue(productQuery([existing]));
    mocks.productFindOneAndUpdate.mockReturnValue(productUpdateQuery(null));

    await expect(
      executeRow()(
        rowArgs({
          value: normalized({ expectedUpdatedAt: updatedAt.toISOString() }),
          duplicate: { existingRecordId: existing._id },
        }),
      ),
    ).rejects.toThrow("Voucher product changed during execution.");

    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("does not create another product when row completion retries after commit", async () => {
    let stored: any = null;
    mocks.productFind.mockImplementation(() =>
      productQuery(stored ? [stored] : []),
    );
    mocks.productCreate.mockImplementation(async ([payload]) => {
      stored = { ...payload, _id: "product-1" };
      return [stored];
    });

    const run = executeRow();
    await expect(run(rowArgs())).resolves.toMatchObject({ action: "created" });
    await expect(run(rowArgs())).resolves.toEqual({
      action: "skipped",
      recordId: "product-1",
      message: "Voucher product row was already applied.",
    });

    expect(mocks.productCreate).toHaveBeenCalledTimes(1);
    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not misclassify an E11000 collision with another identity as a replay", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: 11_000,
    });
    mocks.productCreate.mockRejectedValue(duplicate);
    mocks.productFindOne.mockReturnValue(
      productFindOneQuery({
        _id: "other-product",
        kind: "voucher",
        type: "coupon",
        importMetadata: {
          lastMutationKey: `${sessionId}:2`,
          fingerprint: "0".repeat(64),
        },
      }),
    );

    await expect(executeRow()(rowArgs())).rejects.toMatchObject({
      code: 11_000,
    });

    expect(mocks.productCreate).toHaveBeenCalledTimes(1);
    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("does not activate an imported voucher when publication quota is exhausted", async () => {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    const existing = {
      _id: "product-1", kind: "voucher", type: "coupon", isActive: false,
      price: 1000, currency: "CZK", voucherTemplate: "templates/gift.pdf", updatedAt,
      importMetadata: { externalId: "VOUCHER-PRODUCT-1", importKey: "older:2", lastMutationKey: "older:2" },
    };
    mocks.productFind.mockReturnValue(productQuery([existing]));
    mocks.assertVoucherQuota.mockRejectedValueOnce(new Error("voucher quota exhausted"));
    await expect(executeRow()(rowArgs({ value: normalized({ isActive: true, providedFields: ["isActive"], expectedUpdatedAt: updatedAt.toISOString() }), duplicate: { existingRecordId: existing._id } }))).rejects.toThrow("voucher quota exhausted");
    expect(mocks.acquireVoucherLock).toHaveBeenCalledWith(tenantId, expect.anything());
    expect(mocks.assertVoucherQuota).toHaveBeenCalledWith(expect.objectContaining({ desired: { kind: "voucher", isActive: true } }));
    expect(mocks.productFindOneAndUpdate).not.toHaveBeenCalled();
  });

});
