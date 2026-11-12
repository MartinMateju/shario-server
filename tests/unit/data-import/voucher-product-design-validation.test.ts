import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findProducts: vi.fn(),
  validateStaged: vi.fn((args) => args),
}));

vi.mock("@/modules/product/product.model.js", () => ({
  default: { find: mocks.findProducts },
}));
vi.mock(
  "@/modules/data-import/services/staged-import-validation.service.js",
  () => ({
    validateStagedImportSession: mocks.validateStaged,
  }),
);
vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  createDataImportSession: vi.fn(),
}));

import { DEFAULT_VOUCHER_DESIGN } from "@/modules/coupon/voucher-design.js";
import { validateVoucherProductImportSession } from "@/modules/data-import/services/voucher-product-import.service.js";

const tenantId = "64b64b64b64b64b64b64b64b";
const mapping = {
  name: "name",
  value: "value",
  currency: "currency",
  isActive: "active",
};

const validateRow = async (extraRaw: Record<string, string> = {}) => {
  validateVoucherProductImportSession({
    tenantId,
    actorId: "64a64a64a64a64a64a64a64a",
    sessionId: "import-1",
    mapping,
    duplicateStrategy: "update",
    tenantCurrency: "CZK",
  });
  const prepare = mocks.validateStaged.mock.calls.at(-1)![0].prepare;
  const [result] = await prepare({
    rows: [
      {
        rowNumber: 2,
        raw: {
          name: "Gift voucher",
          value: "1000",
          currency: "CZK",
          active: "true",
          ...extraRaw,
        },
      },
    ],
    mapping,
  });
  return result;
};

const useExisting = (overrides: Record<string, unknown> = {}) => {
  mocks.findProducts.mockReturnValue({
    select: () => ({
      lean: async () => [
        {
          _id: "product-1",
          type: "coupon",
          kind: "voucher",
          name: "Gift voucher",
          price: 1000,
          currency: "CZK",
          voucherTemplate: "",
          isActive: false,
          updatedAt: new Date("2026-08-01T12:00:00Z"),
          importMetadata: { importKey: "older-import:2" },
          ...overrides,
        },
      ],
    }),
  });
};

describe("voucher design compatibility in import validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExisting();
  });

  it("allows activating an existing complete design without a PDF", async () => {
    useExisting({ voucherDesign: DEFAULT_VOUCHER_DESIGN });
    const result = await validateRow();

    expect(result.issues).toEqual([]);
    expect(result.normalized.isActive).toBe(true);
    expect(result.normalized).not.toHaveProperty("voucherDesign");
    expect(mocks.findProducts).toHaveBeenCalledWith({ tenant: tenantId });
  });

  it("rejects malformed stored designs before presenting an executable import", async () => {
    useExisting({ voucherDesign: { version: 1, layout: "split" } });
    const result = await validateRow();

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "VOUCHER_PRODUCT_TEMPLATE_REQUIRED",
        field: "isActive",
      }),
    );
  });

  it("keeps a configured legacy PDF valid for import activation", async () => {
    useExisting({ voucherTemplate: "tenants/studio/voucher.pdf" });
    expect((await validateRow()).issues).toEqual([]);
  });

  it("does not accept an arbitrary design from an unsupported import column", async () => {
    const result = await validateRow({
      voucherDesign: JSON.stringify(DEFAULT_VOUCHER_DESIGN),
    });

    expect(result.normalized).not.toHaveProperty("voucherDesign");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "VOUCHER_PRODUCT_TEMPLATE_REQUIRED",
      }),
    );
  });
});
