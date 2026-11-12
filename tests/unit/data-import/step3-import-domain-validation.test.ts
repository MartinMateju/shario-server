import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateStaged: vi.fn((args) => args),
  loadCustomerIndexes: vi.fn(),
  allocationFind: vi.fn(),
  moneyCreditFind: vi.fn(),
  planFind: vi.fn(),
  versionFind: vi.fn(),
  locationFind: vi.fn(),
  membershipFind: vi.fn(),
  tenantMembershipFindOne: vi.fn(),
  invoiceFind: vi.fn(),
  balanceFind: vi.fn(),
  orderFind: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/staged-import-validation.service.js",
  () => ({ validateStagedImportSession: mocks.validateStaged }),
);
vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  createDataImportSession: vi.fn(),
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
vi.mock("@/modules/money-credit/credit-import-allocation.model.js", () => ({
  default: { find: mocks.allocationFind },
}));
vi.mock("@/modules/money-credit/money-credit.model.js", () => ({
  MoneyCredit: { find: mocks.moneyCreditFind },
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: { find: mocks.planFind },
}));
vi.mock("@/modules/membership/membership-plan-version.model.js", () => ({
  default: { find: mocks.versionFind },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: { find: mocks.locationFind },
}));
vi.mock("@/modules/membership/user-membership.model.js", () => ({
  default: { find: mocks.membershipFind },
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { findOne: mocks.tenantMembershipFindOne },
}));
vi.mock("@/modules/membership/membership-invoice.schema.js", () => ({
  default: { find: mocks.invoiceFind },
}));
vi.mock(
  "@/modules/membership/membership-entitlement-balance.schema.js",
  () => ({ default: { find: mocks.balanceFind } }),
);
vi.mock("@/modules/order/order.model.js", () => ({
  default: { find: mocks.orderFind },
}));

import { validateCreditImportSession } from "@/modules/data-import/services/credit-import.service.js";
import { validateMembershipImportSession } from "@/modules/data-import/services/membership-import.service.js";
import { importFingerprint } from "@/modules/data-import/services/import-domain-resolution.service.js";

const tenantId = "64b64b64b64b64b64b64b64b";
const customerOne = {
  _id: "customer-1",
  email: "one@example.com",
  moneyCredits: 50,
  moneyCreditsMinor: 5_000,
};
const customerTwo = {
  _id: "customer-2",
  email: "two@example.com",
  moneyCredits: 0,
  moneyCreditsMinor: 0,
};

const query = (value: unknown) => ({
  select: () => ({ lean: () => Promise.resolve(value) }),
});

const customerIndexes = () => ({
  users: [customerOne, customerTwo],
  externalId: new Map([
    ["CUS-1", [customerOne]],
    ["CUS-2", [customerTwo]],
  ]),
  email: new Map([
    ["one@example.com", [customerOne]],
    ["two@example.com", [customerTwo]],
  ]),
  phone: new Map(),
});

describe("Step 3 contextual import validation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    vi.clearAllMocks();
    mocks.validateStaged.mockImplementation((args) => args);
    mocks.loadCustomerIndexes.mockResolvedValue(customerIndexes());
  });

  it("rejects conflicting credit customer references and an unsafe allocation decrease", async () => {
    const allocation = {
      _id: "allocation-1",
      user: "customer-1",
      externalId: "ALLOC-1",
      fingerprint: importFingerprint(
        "credit-allocation-v1",
        tenantId,
        "customer-1",
      ),
      targetAmountMinor: 10_000,
      currency: "CZK",
    };
    mocks.allocationFind.mockReturnValue({
      lean: () => Promise.resolve([allocation]),
    });
    mocks.moneyCreditFind.mockImplementation((filter) =>
      filter["transactions.0"]
        ? query([{ user: "customer-1" }])
        : query([
            {
              user: "customer-1",
              balance: 50,
              balanceMinor: 5_000,
              currency: "CZK",
            },
          ]),
    );
    const config = validateCreditImportSession({
      tenantId,
      sessionId: "session-1",
      mapping: {},
      duplicateStrategy: "update",
      actorId: "actor-1",
      tenantCurrency: "CZK",
    }) as any;

    const prepared = await config.prepare({
      rows: [
        {
          rowNumber: 2,
          raw: {
            ID: "ALLOC-1",
            CustomerId: "CUS-1",
            Email: "one@example.com",
            Balance: "40",
          },
        },
        {
          rowNumber: 3,
          raw: {
            CustomerId: "CUS-1",
            Email: "two@example.com",
            Balance: "10",
          },
        },
      ],
      mapping: {
        externalId: "ID",
        customerExternalId: "CustomerId",
        customerEmail: "Email",
        balance: "Balance",
      },
    });

    expect(prepared[0].issues).toContainEqual(
      expect.objectContaining({
        code: "CREDIT_IMPORT_ALLOCATION_DELTA_INSUFFICIENT",
        severity: "error",
      }),
    );
    expect(prepared[1].issues).toContainEqual(
      expect.objectContaining({
        code: "CREDIT_CUSTOMER_IDENTITY_CONFLICT",
        severity: "error",
      }),
    );
    expect(mocks.allocationFind).toHaveBeenCalledWith({ tenant: tenantId });
    expect(mocks.moneyCreditFind).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: tenantId }),
    );
  });

  it("accepts an archived plan's published version and defaults omitted allowances to zero", async () => {
    const plan = {
      _id: "plan-1",
      status: "archived",
      currentPublishedVersion: "version-1",
      importMetadata: { externalId: "PLAN-1" },
    };
    const version = {
      _id: "version-1",
      plan: "plan-1",
      status: "published",
      version: 1,
      name: "Studio plan",
      prices: [{ currency: "CZK", amountMinor: 10_000 }],
      billing: { type: "recurring", interval: "month", intervalCount: 1 },
      locationScope: { type: "all", locationIds: [] },
      benefits: [
        {
          key: "credits",
          label: "Credits",
          type: "allowance",
          unit: "credit",
          quantity: 8,
          adjustable: true,
        },
      ],
    };
    mocks.planFind.mockReturnValue(query([plan]));
    mocks.versionFind.mockReturnValue({
      lean: () => Promise.resolve([version]),
    });
    mocks.locationFind.mockReturnValue(query([]));
    mocks.membershipFind.mockReturnValue(query([]));
    mocks.tenantMembershipFindOne.mockReturnValue(
      query({ locationAccess: { mode: "all", locationIds: [] } }),
    );
    mocks.invoiceFind.mockReturnValue(query([]));
    mocks.balanceFind.mockReturnValue(query([]));
    mocks.orderFind.mockReturnValue(query([]));
    const config = validateMembershipImportSession({
      tenantId,
      sessionId: "session-1",
      mapping: {},
      duplicateStrategy: "skip",
      actorId: "actor-1",
      tenantCurrency: "CZK",
    }) as any;

    const [prepared] = await config.prepare({
      rows: [
        {
          rowNumber: 2,
          raw: {
            Customer: "one@example.com",
            Plan: "PLAN-1",
            Status: "active",
            Started: "2026-08-01",
            PeriodStart: "2026-08-01",
            PeriodEnd: "2026-09-01",
          },
        },
      ],
      mapping: {
        customerEmail: "Customer",
        planExternalId: "Plan",
        status: "Status",
        startedAt: "Started",
        periodStart: "PeriodStart",
        periodEnd: "PeriodEnd",
      },
    });

    expect(prepared.normalized).toMatchObject({
      customerId: "customer-1",
      planId: "plan-1",
      planVersionId: "version-1",
      planVersion: 1,
      currency: "CZK",
      amountMinor: 10_000,
      allowanceTargets: { credits: 0 },
    });
    expect(prepared.issues).toEqual([
      expect.objectContaining({
        code: "MEMBERSHIP_ALLOWANCE_DEFAULTED_ZERO",
        severity: "warning",
      }),
    ]);
  });

  it("rejects spendable allowances on a terminal membership and warns on unknown cancellation time", async () => {
    const plan = {
      _id: "plan-1",
      status: "published",
      currentPublishedVersion: "version-1",
      importMetadata: { externalId: "PLAN-1" },
    };
    const version = {
      _id: "version-1",
      plan: "plan-1",
      status: "published",
      version: 1,
      name: "Studio plan",
      prices: [{ currency: "CZK", amountMinor: 10_000 }],
      billing: { type: "recurring", interval: "month", intervalCount: 1 },
      locationScope: { type: "all", locationIds: [] },
      benefits: [
        {
          key: "credits",
          label: "Credits",
          type: "allowance",
          unit: "credit",
          quantity: 8,
          adjustable: true,
        },
      ],
    };
    mocks.planFind.mockReturnValue(query([plan]));
    mocks.versionFind.mockReturnValue({
      lean: () => Promise.resolve([version]),
    });
    mocks.locationFind.mockReturnValue(query([]));
    mocks.membershipFind.mockReturnValue(query([]));
    mocks.tenantMembershipFindOne.mockReturnValue(
      query({ locationAccess: { mode: "all", locationIds: [] } }),
    );
    mocks.invoiceFind.mockReturnValue(query([]));
    mocks.balanceFind.mockReturnValue(query([]));
    mocks.orderFind.mockReturnValue(query([]));
    const config = validateMembershipImportSession({
      tenantId,
      sessionId: "session-1",
      mapping: {},
      duplicateStrategy: "skip",
      actorId: "actor-1",
      tenantCurrency: "CZK",
    }) as any;

    const prepared = await config.prepare({
      rows: [
        {
          rowNumber: 2,
          raw: {
            Customer: "one@example.com",
            Plan: "PLAN-1",
            Status: "expired",
            Started: "2026-01-01",
            PeriodEnd: "2026-07-01",
            Balances: '{"credits":2}',
          },
        },
        {
          rowNumber: 3,
          raw: {
            Customer: "two@example.com",
            Plan: "PLAN-1",
            Status: "cancelled",
            Started: "2026-02-01",
            PeriodEnd: "2026-07-01",
            Balances: "{}",
          },
        },
      ],
      mapping: {
        customerEmail: "Customer",
        planExternalId: "Plan",
        status: "Status",
        startedAt: "Started",
        periodEnd: "PeriodEnd",
        allowanceBalances: "Balances",
      },
    });

    expect(prepared[0].issues).toContainEqual(
      expect.objectContaining({
        code: "MEMBERSHIP_TERMINAL_ALLOWANCE_NONZERO",
        severity: "error",
      }),
    );
    expect(prepared[1].issues).toContainEqual(
      expect.objectContaining({
        code: "MEMBERSHIP_CANCELLED_AT_UNKNOWN",
        severity: "warning",
      }),
    );
  });
});
