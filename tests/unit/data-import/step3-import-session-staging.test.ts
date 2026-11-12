import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseImportFile: vi.fn(),
  getImportFileType: vi.fn(),
  sessionCreate: vi.fn(),
  rowInsertMany: vi.fn(),
  sessionDeleteOne: vi.fn(),
  rowDeleteMany: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/modules/data-import/data-import-session.model.js", () => ({
  default: {
    create: mocks.sessionCreate,
    deleteOne: mocks.sessionDeleteOne,
  },
}));
vi.mock("@/modules/data-import/data-import-row.model.js", () => ({
  default: {
    insertMany: mocks.rowInsertMany,
    deleteMany: mocks.rowDeleteMany,
  },
}));
vi.mock("@/modules/data-import/services/import-file-parser.service.js", () => ({
  parseImportFile: mocks.parseImportFile,
  getImportFileType: mocks.getImportFileType,
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: {},
}));

import { createDataImportSession } from "@/modules/data-import/services/data-import.service.js";

type Case = {
  entityType:
    | "membership-plans"
    | "memberships"
    | "credits"
    | "voucher-products"
    | "vouchers";
  headers: string[];
  expectedMapping: Record<string, string>;
};

const cases: Case[] = [
  {
    entityType: "membership-plans",
    headers: ["Plan name", "Price", "Billing type"],
    expectedMapping: {
      name: "Plan name",
      price: "Price",
      billingType: "Billing type",
    },
  },
  {
    entityType: "memberships",
    headers: [
      "Customer email",
      "Plan ID",
      "Membership start",
      "Current period end",
    ],
    expectedMapping: {
      customerEmail: "Customer email",
      planExternalId: "Plan ID",
      startedAt: "Membership start",
      periodEnd: "Current period end",
    },
  },
  {
    entityType: "credits",
    headers: ["Customer email", "Opening balance"],
    expectedMapping: {
      customerEmail: "Customer email",
      balance: "Opening balance",
    },
  },
  {
    entityType: "voucher-products",
    headers: ["Voucher name", "Value"],
    expectedMapping: { name: "Voucher name", value: "Value" },
  },
  {
    entityType: "vouchers",
    headers: ["Promo code", "Product SKU", "Voucher value"],
    expectedMapping: {
      promoCode: "Promo code",
      productSku: "Product SKU",
      value: "Voucher value",
    },
  },
];

describe("Step 3 shared import session staging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getImportFileType.mockReturnValue("csv");
    mocks.rowInsertMany.mockResolvedValue([]);
    mocks.recordAudit.mockResolvedValue({});
    mocks.sessionCreate.mockImplementation(async (payload) => ({
      ...payload,
      _id: "session-1",
      toObject: () => ({ ...payload, _id: "session-1" }),
    }));
  });

  it.each(cases)(
    "stages $entityType through the shared parser and mapping engine",
    async ({ entityType, headers, expectedMapping }) => {
      mocks.parseImportFile.mockResolvedValue({
        headers,
        rows: [Object.fromEntries(headers.map((header) => [header, "value"]))],
        sheetName: null,
      });

      await createDataImportSession({
        tenantId: "tenant-1",
        actorId: "actor-1",
        entityType,
        file: {
          buffer: Buffer.from(headers.join(",")),
          originalname: `${entityType}.csv`,
          mimetype: "text/csv",
        } as Express.Multer.File,
      });

      expect(mocks.sessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: "tenant-1",
          createdBy: "actor-1",
          entityType,
          suggestedMapping: expectedMapping,
          summary: { total: 1 },
        }),
      );
      expect(mocks.rowInsertMany).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            tenant: "tenant-1",
            session: "session-1",
            rowNumber: 2,
            status: "pending",
          }),
        ],
        { ordered: true },
      );
      expect(mocks.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          sessionId: "session-1",
          actorId: "actor-1",
          action: "uploaded",
          metadata: expect.objectContaining({ entityType, fileType: "csv" }),
        }),
      );
    },
  );

  it("rolls back both staged collections when row persistence fails", async () => {
    mocks.parseImportFile.mockResolvedValue({
      headers: ["Customer email", "Opening balance"],
      rows: [
        { "Customer email": "customer@example.com", "Opening balance": "10" },
      ],
      sheetName: null,
    });
    const failure = new Error("row write failed");
    mocks.rowInsertMany.mockRejectedValue(failure);
    mocks.sessionDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mocks.rowDeleteMany.mockResolvedValue({ deletedCount: 0 });

    await expect(
      createDataImportSession({
        tenantId: "tenant-1",
        actorId: "actor-1",
        entityType: "credits",
        file: {
          buffer: Buffer.from("Customer email,Opening balance"),
          originalname: "credits.csv",
          mimetype: "text/csv",
        } as Express.Multer.File,
      }),
    ).rejects.toBe(failure);

    expect(mocks.sessionDeleteOne).toHaveBeenCalledWith({ _id: "session-1" });
    expect(mocks.rowDeleteMany).toHaveBeenCalledWith({ session: "session-1" });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
