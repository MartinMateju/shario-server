import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateStaged: vi.fn((args) => args),
  productFind: vi.fn(),
  planFind: vi.fn(),
  locationFind: vi.fn(),
  tenantMembershipFindOne: vi.fn(),
  couponFind: vi.fn(),
  moneyCreditAggregate: vi.fn(),
  loadCustomerIndexes: vi.fn(),
  planSafeParse: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/staged-import-validation.service.js",
  () => ({ validateStagedImportSession: mocks.validateStaged }),
);
vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  createDataImportSession: vi.fn(),
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { find: mocks.productFind },
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: { find: mocks.planFind },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: { find: mocks.locationFind },
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { findOne: mocks.tenantMembershipFindOne },
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: { find: mocks.couponFind },
}));
vi.mock("@/modules/money-credit/money-credit.model.js", () => ({
  MoneyCredit: { aggregate: mocks.moneyCreditAggregate },
}));
vi.mock("@/modules/membership/membership.validators.js", () => ({
  createMembershipPlanSchema: { safeParse: mocks.planSafeParse },
}));
vi.mock(
  "@/modules/data-import/services/import-domain-resolution.service.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/modules/data-import/services/import-domain-resolution.service.js")
      >();
    return { ...actual, loadImportCustomerIndexes: mocks.loadCustomerIndexes };
  },
);

import { validateMembershipPlanImportSession } from "@/modules/data-import/services/membership-plan-import.service.js";
import { validateVoucherProductImportSession } from "@/modules/data-import/services/voucher-product-import.service.js";
import { validateVoucherImportSession } from "@/modules/data-import/services/voucher-import.service.js";

const tenantId = "64b64b64b64b64b64b64b64b";

const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });
const selectLean = (value: unknown) => ({ select: () => lean(value) });
const selectPopulateLean = (value: unknown) => ({
  select: () => ({ populate: () => lean(value) }),
});

describe("Step 3 UPDATE blank-cell preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateStaged.mockImplementation((args) => args);
    mocks.planSafeParse.mockReturnValue({ success: true, data: {} });
    mocks.locationFind.mockReturnValue(selectLean([]));
    mocks.tenantMembershipFindOne.mockReturnValue(
      selectLean({ locationAccess: { mode: "all", locationIds: [] } }),
    );
    mocks.moneyCreditAggregate.mockResolvedValue([]);
    mocks.loadCustomerIndexes.mockResolvedValue({
      users: [],
      externalId: new Map(),
      email: new Map(),
      phone: new Map(),
    });
  });

  it("inherits blank membership-plan cells from the current published version", async () => {
    const plan = {
      _id: "plan-1",
      status: "published",
      sortOrder: 9,
      importMetadata: { externalId: "PLAN-1" },
      currentPublishedVersion: {
        name: "Studio Plus",
        description: "Old description",
        terms: "Keep terms",
        prices: [{ currency: "CZK", amountMinor: 149_000 }],
        billing: { type: "recurring", interval: "month", intervalCount: 1 },
        locationScope: { type: "all", locationIds: [] },
        benefits: [
          {
            key: "credits",
            type: "allowance",
            label: "Credits",
            unit: "credit",
            quantity: 8,
            adjustable: true,
          },
        ],
      },
    };
    mocks.planFind.mockReturnValue(selectPopulateLean([plan]));
    const config = validateMembershipPlanImportSession({
      tenantId,
      sessionId: "session-1",
      mapping: {},
      duplicateStrategy: "update",
      actorId: "actor-1",
      tenantCurrency: "CZK",
    }) as any;

    const [prepared] = await config.prepare({
      rows: [
        {
          rowNumber: 2,
          raw: {
            ID: "PLAN-1",
            Name: "",
            Price: "",
            Billing: "",
            Description: "Updated description",
          },
        },
      ],
      mapping: {
        externalId: "ID",
        name: "Name",
        price: "Price",
        billingType: "Billing",
        description: "Description",
      },
    });

    expect(prepared.normalized).toMatchObject({
      externalId: "PLAN-1",
      name: "Studio Plus",
      description: "Updated description",
      terms: "Keep terms",
      price: 1490,
      currency: "CZK",
      billingType: "recurring",
      billingInterval: "month",
      intervalCount: 1,
      locationScope: "all",
      sortOrder: 9,
    });
    expect(prepared.issues).toEqual([]);
  });

  it("inherits blank voucher-product name and major-unit value exactly", async () => {
    const product = {
      _id: "product-1",
      name: "Gift voucher",
      description: "Old description",
      sku: "GIFT-1500",
      kind: "voucher",
      type: "coupon",
      price: 1500,
      currency: "CZK",
      isActive: false,
      sortOrder: 4,
      voucherTemplate: "",
      importMetadata: { externalId: "VP-1" },
    };
    mocks.productFind.mockReturnValue(selectLean([product]));
    const config = validateVoucherProductImportSession({
      tenantId,
      sessionId: "session-1",
      mapping: {},
      duplicateStrategy: "update",
      actorId: "actor-1",
      tenantCurrency: "CZK",
    }) as any;

    const [prepared] = await config.prepare({
      rows: [
        {
          rowNumber: 2,
          raw: {
            ID: "VP-1",
            Name: "",
            Value: "",
            Description: "Updated description",
          },
        },
      ],
      mapping: {
        externalId: "ID",
        name: "Name",
        value: "Value",
        description: "Description",
      },
    });

    expect(prepared.normalized).toMatchObject({
      externalId: "VP-1",
      name: "Gift voucher",
      description: "Updated description",
      sku: "GIFT-1500",
      value: 1500,
      currency: "CZK",
      isActive: false,
      sortOrder: 4,
    });
    expect(prepared.issues).toEqual([]);
  });

  it("inherits immutable voucher product/value/currency snapshots from blank cells", async () => {
    const product = {
      _id: "product-1",
      name: "Gift voucher",
      sku: "GIFT-1500",
      kind: "voucher",
      type: "coupon",
      importMetadata: { externalId: "VP-1" },
    };
    const voucher = {
      _id: "voucher-1",
      product: "product-1",
      promoCode: "STUDIO-2026-01",
      isActive: true,
      expiresAt: null,
      redeemedAt: null,
      redeemedBy: null,
      valueMinorSnapshot: 150_000,
      currencySnapshot: "CZK",
      importMetadata: { externalId: "V-1", note: "Original note" },
    };
    mocks.productFind.mockReturnValue(selectLean([product]));
    mocks.couponFind.mockReturnValue(selectLean([voucher]));
    const config = validateVoucherImportSession({
      tenantId,
      sessionId: "session-1",
      mapping: {},
      duplicateStrategy: "update",
      actorId: "actor-1",
      tenantCurrency: "CZK",
    }) as any;

    const [prepared] = await config.prepare({
      rows: [
        {
          rowNumber: 2,
          raw: {
            ID: "V-1",
            Code: "",
            Product: "",
            Value: "",
            Currency: "",
            Status: "disabled",
            Note: "Migration cutover",
          },
        },
      ],
      mapping: {
        externalId: "ID",
        promoCode: "Code",
        productSku: "Product",
        value: "Value",
        currency: "Currency",
        status: "Status",
        note: "Note",
      },
    });

    expect(prepared.normalized).toMatchObject({
      externalId: "V-1",
      promoCode: "STUDIO-2026-01",
      productId: "product-1",
      status: "disabled",
      value: 1500,
      valueMinor: 150_000,
      currency: "CZK",
      note: "Migration cutover",
    });
    expect(prepared.issues).toEqual([]);
  });
});
