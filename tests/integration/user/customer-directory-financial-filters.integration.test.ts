import mongoose from "mongoose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import User from "@/modules/user/user.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Order from "@/modules/order/order.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import {
  ALL_WORKSPACE_PERMISSIONS,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import {
  exportCustomerDirectory,
  getCustomerDirectorySummary,
  listCustomerDirectory,
} from "@/modules/user/services/user.directory.service.js";
import * as metrics from "@/modules/user/services/user.directory-metrics.service.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenant = new mongoose.Types.ObjectId();
const foreignTenant = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const now = new Date("2026-11-17T12:00:00Z");
const access = (patch: Record<string, unknown> = {}) =>
  ({
    tenantId: String(tenant),
    status: "active",
    permissions: ALL_WORKSPACE_PERMISSIONS,
    locationAccess: { mode: "all", locationIds: [] },
    ...patch,
  }) as ResolvedWorkspaceAccess;
const context = (patch: Record<string, unknown> = {}) => ({
  tenantId: String(tenant),
  access: access(patch),
  now,
});
const user = (number: number, patch: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant,
  tenantRole: "customer",
  platformRole: "none",
  firstname: "Customer",
  lastname: String(number),
  email: `financial-filter-${number}@example.test`,
  memberNumber: number,
  customId: `financial-filter-${number}`,
  isAccessGranted: true,
  moneyCredits: number,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, number)),
  ...patch,
});
const order = (
  customer: mongoose.Types.ObjectId,
  patch: Record<string, unknown> = {},
) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant,
  createdBy: customer,
  isPaid: true,
  status: "processed_order",
  currency: "CZK",
  paidAmountMinor: 10000,
  paidAt: new Date("2026-10-25T12:00:00Z"),
  locationIds: [location],
  ...patch,
});
const list = (
  input: Record<string, unknown> = {},
  patch: Record<string, unknown> = {},
) => listCustomerDirectory({ ...context(patch), input });
const exported = async (
  input: Record<string, unknown> = {},
  patch: Record<string, unknown> = {},
) => {
  const result: any[] = [];
  for await (const batch of exportCustomerDirectory({
    ...context(patch),
    input,
  }))
    result.push(...batch);
  return result;
};
const ids = (rows: any[]) => rows.map((row) => String(row._id));
const period = {
  spendFrom: "2026-10-25",
  spendTo: "2026-10-25",
  timeZone: "Europe/Prague",
};

describe("customer directory spending and current credit filters", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await clearTestDatabase();
    await Tenant.collection.insertOne({
      _id: tenant,
      settings: { currency: "CZK" },
      modules: { memberships: true },
      plan: "professional",
      planVersion: 3,
    });
  });

  it("combines inclusive financial predicates before counting/paging and exports the same whole-directory result in bounded batches", async () => {
    const rows = Array.from({ length: 125 }, (_, index) => user(index));
    const foreign = user(200, { tenant: foreignTenant, moneyCredits: 50 });
    const staff = user(201, { tenantRole: "owner", moneyCredits: 50 });
    const support = user(202, { platformRole: "support", moneyCredits: 50 });
    await User.collection.insertMany([...rows, foreign, staff, support]);
    await Order.collection.insertMany([
      ...rows.map((row, index) =>
        order(row._id, { paidAmountMinor: index * 100 }),
      ),
      order(foreign._id, { paidAmountMinor: 5000, tenant: foreignTenant }),
      order(staff._id, { paidAmountMinor: 5000 }),
      order(support._id, { paidAmountMinor: 5000 }),
      order(rows[50]._id, { paidAmountMinor: 9999999, tenant: foreignTenant }),
    ]);
    const hydration = vi.spyOn(metrics, "withCustomerDirectoryMetrics");
    const filters = {
      spendMin: 40,
      spendMax: 90,
      creditMin: 20,
      creditMax: 110,
    };
    const result = await list({ ...filters, page: 3, limit: 10 });
    const expected = rows.slice(40, 91).reverse();
    expect(result).toMatchObject({
      totalCount: 51,
      totalPages: 6,
      currentPage: 3,
      pageSize: 10,
    });
    expect(ids(result.data)).toEqual(ids(expected.slice(20, 30)));
    expect(ids(await exported(filters))).toEqual(ids(expected));
    expect(
      hydration.mock.calls.every(([input]) => input.users.length <= 100),
    ).toBe(true);
  });

  it("uses local inclusive payment dates across DST, includes every payment source and subtracts later recorded refunds without changing lifetime totals", async () => {
    const paid = user(1);
    const zero = user(2);
    await User.collection.insertMany([paid, zero]);
    const firstInstant = order(paid._id, {
      paidAt: new Date("2026-10-24T22:00:00Z"),
    });
    await Order.collection.insertMany([
      firstInstant,
      order(paid._id, {
        paidAmountMinor: 20000,
        paidAt: new Date("2026-10-24T21:59:59.999Z"),
      }),
      order(paid._id, {
        paidAmountMinor: 10000,
        paidAt: new Date("2026-10-25T23:00:00Z"),
      }),
    ]);
    await BookingPaymentRefund.collection.insertOne({
      tenant,
      order: firstInstant._id,
      customer: paid._id,
      currency: "CZK",
      status: "succeeded",
      cardAmountMinor: 2500,
      amountMinor: 2500,
      completedAt: new Date("2026-11-01T12:00:00Z"),
    });
    await CouponOrder.collection.insertOne({
      tenant,
      createdBy: paid._id,
      paidAt: new Date("2026-10-25T22:59:59.999Z"),
      currencySnapshot: "CZK",
      expectedAmountMinor: 5000,
      refundedAmountMinor: 2000,
    });
    await MembershipInvoice.collection.insertOne({
      tenant,
      user: paid._id,
      connectedAccountId: "financial-fixture-account",
      stripeInvoiceId: "financial-period-paid",
      paidAt: new Date("2026-10-25T01:30:00Z"),
      status: "paid",
      currency: "CZK",
      amountPaidMinor: 4000,
    });
    const result = await list(period);
    expect(result.totalCount).toBe(2); // Date context alone never hides zero spenders.
    expect(
      result.data.find((row: any) => String(row._id) === String(paid._id)),
    ).toMatchObject({
      totalSpentByCurrency: [{ currency: "CZK", amountMinor: 44500 }],
      periodSpentByCurrency: [{ currency: "CZK", amountMinor: 14500 }],
      periodSpentCurrency: "CZK",
    });
    expect(
      result.data.find((row: any) => String(row._id) === String(zero._id)),
    ).toMatchObject({
      periodSpentByCurrency: [],
      periodSpentCurrency: "CZK",
    });
    expect(
      ids((await list({ ...period, spendMin: 145, spendMax: 145 })).data),
    ).toEqual([String(paid._id)]);
    expect(
      ids(await exported({ ...period, spendMin: 145, spendMax: 145 })),
    ).toEqual([String(paid._id)]);
    expect(await exported({ ids: [String(paid._id)], ...period })).toEqual([
      expect.objectContaining({
        _id: paid._id,
        totalSpentByCurrency: [{ currency: "CZK", amountMinor: 44500 }],
        periodSpentByCurrency: [{ currency: "CZK", amountMinor: 14500 }],
      }),
    ]);
    expect(
      (
        await list({
          spendTo: "2026-10-25",
          timeZone: "Europe/Prague",
          spendMin: 345,
          spendMax: 345,
        })
      ).totalCount,
    ).toBe(1);
    expect(
      (
        await list({
          spendFrom: "2026-10-25",
          timeZone: "Europe/Prague",
          spendMin: 245,
          spendMax: 245,
        })
      ).totalCount,
    ).toBe(1);
  });

  it("never matches missing payment dates or invalid amounts as known zero, and excludes mixed currencies from scalar ranges", async () => {
    const [zero, undated, invalid, mixed, foreignCurrency] = [
      1, 2, 3, 4, 5,
    ].map((n) => user(n));
    await User.collection.insertMany([
      zero,
      undated,
      invalid,
      mixed,
      foreignCurrency,
    ]);
    await Order.collection.insertMany([
      order(undated._id, { paidAt: null }),
      order(invalid._id, { paidAmountMinor: null }),
      order(mixed._id, { paidAmountMinor: 100 }),
      order(mixed._id, { paidAmountMinor: 100, currency: "EUR" }),
      order(foreignCurrency._id, { paidAmountMinor: 100, currency: "EUR" }),
    ]);
    const contextual = await list(period);
    expect(contextual.totalCount).toBe(5);
    expect(
      contextual.data.find(
        (row: any) => String(row._id) === String(undated._id),
      ),
    ).toMatchObject({
      totalSpentByCurrency: [{ currency: "CZK", amountMinor: 10000 }],
      periodSpentByCurrency: null,
      periodSpentCurrency: null,
    });
    expect(
      ids((await list({ ...period, spendMin: 0, spendMax: 0 })).data),
    ).toEqual([String(zero._id)]);
    expect(
      ids(await exported({ ...period, spendMin: 0, spendMax: 0 })),
    ).toEqual([String(zero._id)]);
    expect(ids((await list({ spendMin: 100, spendMax: 100 })).data)).toEqual([
      String(undated._id),
    ]);
    expect((await list({ spendMin: 1, spendMax: 1 })).totalCount).toBe(0);
  });

  it("uses authoritative current minor credits, supports signed bounds, and does not convert malformed or absent balances to zero", async () => {
    const authoritative = user(1, {
      moneyCreditsMinor: 1234,
      moneyCredits: 999,
    });
    const legacy = user(2, { moneyCreditsMinor: null, moneyCredits: 12.34 });
    const zero = user(3, { moneyCredits: 0 });
    const negative = user(4, { moneyCredits: -5 });
    const malformed = user(5, { moneyCredits: "not-a-balance" });
    const invalidMinor = user(6, {
      moneyCreditsMinor: "unknown",
      moneyCredits: "unknown",
    });
    const missing = user(7);
    const validFallback = user(8, {
      moneyCreditsMinor: -1,
      moneyCredits: 12.34,
    });
    delete (missing as any).moneyCredits;
    await User.collection.insertMany([
      authoritative,
      legacy,
      zero,
      negative,
      malformed,
      invalidMinor,
      missing,
      validFallback,
    ]);
    const result = await list({ creditMin: 12.34, creditMax: 12.34 });
    expect(ids(result.data)).toEqual([
      String(validFallback._id),
      String(legacy._id),
      String(authoritative._id),
    ]);
    expect(result.data.every((row: any) => row.moneyCredits === 12.34)).toBe(
      true,
    );
    expect(ids(await exported({ creditMin: 12.34, creditMax: 12.34 }))).toEqual(
      ids(result.data),
    );
    expect(ids((await list({ creditMin: 0, creditMax: 0 })).data)).toEqual([
      String(zero._id),
    ]);
    expect((await list({ creditMax: -5 })).totalCount).toBe(0); // Canonical stored balances cannot be negative.
    expect((await list({ creditMin: -5, creditMax: 0 })).totalCount).toBe(1);
    expect((await list({ creditMin: 0 })).totalCount).toBe(4);
    expect(
      (await getCustomerDirectorySummary({ ...context(), input: {} })).summary
        .credits,
    ).toBeNull();
  });

  it("does not treat confirmed vouchers or invoices with incomplete payment evidence as customers with no spending history", async () => {
    const [voucher, invoice, zeroInvoice, noHistory] = [1, 2, 3, 4].map((n) =>
      user(n),
    );
    await User.collection.insertMany([
      voucher,
      invoice,
      zeroInvoice,
      noHistory,
    ]);
    await CouponOrder.collection.insertOne({
      tenant,
      createdBy: voucher._id,
      status: "processed_coupon",
      paidAt: null,
      currencySnapshot: "CZK",
      expectedAmountMinor: 5000,
      refundedAmountMinor: 0,
    });
    await MembershipInvoice.collection.insertMany([
      {
        tenant,
        user: invoice._id,
        connectedAccountId: "financial-fixture-account",
        stripeInvoiceId: "financial-paid-missing-amount",
        status: "paid",
        paidAt: null,
        currency: "CZK",
      },
      {
        tenant,
        user: zeroInvoice._id,
        connectedAccountId: "financial-fixture-account",
        stripeInvoiceId: "financial-paid-zero-missing-date",
        status: "paid",
        paidAt: null,
        currency: "CZK",
        amountPaidMinor: 0,
      },
    ]);
    const result = await list(period);
    expect(result.totalCount).toBe(4);
    for (const incomplete of [voucher, invoice]) {
      expect(
        result.data.find(
          (row: any) => String(row._id) === String(incomplete._id),
        ),
      ).toMatchObject({
        totalSpentByCurrency: null,
        periodSpentByCurrency: null,
      });
    }
    expect(
      result.data.find(
        (row: any) => String(row._id) === String(zeroInvoice._id),
      ),
    ).toMatchObject({
      totalSpent: 0,
      totalSpentByCurrency: [{ currency: "CZK", amountMinor: 0 }],
      periodSpentByCurrency: null,
    });
    expect(
      ids((await list({ ...period, spendMin: 0, spendMax: 0 })).data),
    ).toEqual([String(noHistory._id)]);
    expect(
      ids(await exported({ ...period, spendMin: 0, spendMax: 0 })),
    ).toEqual([String(noHistory._id)]);
    expect(ids((await list({ spendMin: 0, spendMax: 0 })).data)).toEqual([
      String(noHistory._id),
      String(zeroInvoice._id),
    ]);
  });

  it("deduplicates cumulative order refunds and includes reconciled invoice refunds, keeping conflicts and review snapshots unknown", async () => {
    const [known, conflicting, review] = [1, 2, 3].map((n) => user(n));
    await User.collection.insertMany([known, conflicting, review]);
    await Order.collection.insertMany([
      order(known._id, {
        pieceCheckout: { refundedAmountMinor: 2000 },
        refund: {
          succeededAmountMinor: 2000,
          status: "partial",
          reviewRequired: false,
        },
      }),
      order(conflicting._id, {
        pieceCheckout: { refundedAmountMinor: 2000 },
        refund: {
          succeededAmountMinor: 1000,
          status: "partial",
          reviewRequired: false,
        },
      }),
    ]);
    await MembershipInvoice.collection.insertMany([
      {
        tenant,
        user: known._id,
        connectedAccountId: "financial-fixture-account",
        stripeInvoiceId: "financial-reconciled-known",
        paidAt: new Date("2026-10-25T12:00:00Z"),
        currency: "CZK",
        amountPaidMinor: 5000,
        refund: {
          succeededAmountMinor: 1000,
          status: "partial",
          reviewRequired: false,
        },
      },
      {
        tenant,
        user: review._id,
        connectedAccountId: "financial-fixture-account",
        stripeInvoiceId: "financial-reconciled-review",
        paidAt: new Date("2026-10-25T12:00:00Z"),
        currency: "CZK",
        amountPaidMinor: 5000,
        refund: {
          succeededAmountMinor: 1000,
          status: "review",
          reviewRequired: true,
        },
      },
    ]);
    const result = await list(period);
    expect(
      result.data.find((row: any) => String(row._id) === String(known._id)),
    ).toMatchObject({
      totalSpentByCurrency: [{ currency: "CZK", amountMinor: 12000 }],
      periodSpentByCurrency: [{ currency: "CZK", amountMinor: 12000 }],
    });
    for (const uncertain of [conflicting, review]) {
      expect(
        result.data.find(
          (row: any) => String(row._id) === String(uncertain._id),
        ),
      ).toMatchObject({
        totalSpentByCurrency: null,
        periodSpentByCurrency: null,
      });
    }
    expect(
      ids((await list({ ...period, spendMin: 120, spendMax: 120 })).data),
    ).toEqual([String(known._id)]);
    expect(
      (await list({ ...period, spendMin: 0, spendMax: 0 })).totalCount,
    ).toBe(0);
  });

  it("rejects unsupported precision and unsafe amounts in the tenant currency", async () => {
    for (const field of ["spendMin", "spendMax", "creditMin", "creditMax"]) {
      await expect(list({ [field]: 1.001 })).rejects.toThrow();
      await expect(exported({ [field]: 1.001 })).rejects.toThrow();
      await expect(
        list({ [field]: Number.MAX_SAFE_INTEGER }),
      ).rejects.toThrow();
    }
    await Tenant.collection.updateOne(
      { _id: tenant },
      { $set: { "settings.currency": "JPY" } },
    );
    await expect(list({ creditMin: 0.5 })).rejects.toThrow();
    await expect(list({ spendMax: 0.5 })).rejects.toThrow();
    expect(await list({ spendMin: 0, creditMax: 100 })).toMatchObject({
      totalCount: 0,
    });
  });

  it("rejects financial filter oracles outside full spending scope while leaving date-only and credit-only directory access available", async () => {
    const customer = user(1, { moneyCredits: 5 });
    await User.collection.insertOne(customer);
    await Order.collection.insertOne(order(customer._id));
    const restrictedScopes = [
      {
        permissions: ALL_WORKSPACE_PERMISSIONS.filter(
          (permission) => permission !== WORKSPACE_PERMISSION.PAYMENTS_VIEW,
        ),
      },
      { locationAccess: { mode: "selected", locationIds: [String(location)] } },
    ];
    for (const restricted of restrictedScopes) {
      await expect(list({ spendMin: 0 }, restricted)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        exported({ spendMax: 1000 }, restricted),
      ).rejects.toMatchObject({ statusCode: 403 });
      const rows = await list(period, restricted);
      expect(rows.totalCount).toBe(1);
      expect(rows.data[0]).toMatchObject({
        totalSpentByCurrency: null,
        periodSpentByCurrency: null,
      });
      expect(
        (await list({ creditMin: 5, creditMax: 5 }, restricted)).totalCount,
      ).toBe(1);
      expect(
        await getCustomerDirectorySummary({
          ...context(restricted),
          input: {},
        }),
      ).toMatchObject({ spendingAvailable: false, currency: "CZK" });
    }
    expect(
      await getCustomerDirectorySummary({ ...context(), input: {} }),
    ).toMatchObject({ spendingAvailable: true, currency: "CZK" });
  });

  it("preserves selected-export scope verification with period context", async () => {
    const customer = user(1);
    const foreign = user(2, { tenant: foreignTenant });
    await User.collection.insertMany([customer, foreign]);
    await expect(
      exported({ ids: [String(customer._id), String(foreign._id)], ...period }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      exported({ ids: [String(customer._id)], ...period, creditMax: 0 }),
    ).rejects.toThrow();
  });
});
