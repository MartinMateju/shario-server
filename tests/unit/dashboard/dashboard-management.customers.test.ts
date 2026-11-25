import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), order: vi.fn(), refund: vi.fn(), voucher: vi.fn(), invoice: vi.fn() }));
vi.mock("@/modules/user/user.model.js", () => ({ default: { find: mocks.user } }));
vi.mock("@/modules/order/order.model.js", () => ({ default: { find: mocks.order } }));
vi.mock("@/modules/booking/booking-payment-refund.model.js", () => ({ BookingPaymentRefund: { find: mocks.refund } }));
vi.mock("@/modules/coupon/coupon.model.js", () => ({ CouponOrder: { find: mocks.voucher } }));
vi.mock("@/modules/membership/membership-invoice.schema.js", () => ({ default: { find: mocks.invoice } }));

import { getManagementCustomerDetails, getManagementSpendingRanking } from "@/modules/dashboard/dashboard-management.customers.js";

const tenant = "100000000000000000000001";
const customer = "200000000000000000000001";
const second = "200000000000000000000002";
const orderId = "300000000000000000000001";
const now = new Date("2026-11-08T12:00:00Z");
const query = (rows: any[]) => {
  const chain = { select: vi.fn(), limit: vi.fn(), lean: vi.fn().mockResolvedValue(rows) };
  chain.select.mockReturnValue(chain); chain.limit.mockReturnValue(chain);
  return chain;
};
const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: orderId, createdBy: customer, paidAt: new Date("2026-11-03T12:00:00Z"), currency: "CZK", paidAmountMinor: 10000, ...overrides,
});
const run = (overrides: Record<string, unknown> = {}) => getManagementCustomerDetails({
  tenantId: tenant, customerIds: [customer, second], canViewSpending: true, currency: "CZK",
  monthStart: new Date("2026-10-31T23:00:00Z"), asOf: now, now, ...overrides,
} as any);
beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockImplementation(() => query([]));
  mocks.user.mockImplementation(() => query([{ _id: customer, memberNumber: 42 }]));
});

describe("ranked customer identity and workspace cash spending", () => {
  it("returns customer-facing ID and no finance reads without full finance scope", async () => {
    const result = await run({ canViewSpending: false });
    expect(result.details.get(customer)).toEqual({ memberNumber: 42, spentMonthMinor: null, spentTotalMinor: null });
    expect(result.details.get(second)?.memberNumber).toBeNull();
    for (const model of [mocks.order, mocks.refund, mocks.voucher, mocks.invoice]) expect(model).not.toHaveBeenCalled();
    expect(mocks.user).toHaveBeenCalledWith({ tenant, _id: { $in: [customer, second] } });
  });
  it("matches canonical net cash across orders, vouchers and membership invoices without counting redemption twice", async () => {
    mocks.order.mockImplementation(() => query([
      paidOrder({ status: "cancelled" }),
      paidOrder({ _id: "old", paidAt: new Date("2026-10-01T10:00:00Z"), paidAmountMinor: 5000 }),
      paidOrder({ _id: "redemption", paidAmountMinor: 0 }),
    ]));
    mocks.refund.mockImplementation(() => query([{
      order: orderId, customer, currency: "CZK", cardAmountMinor: 2000, voucherAmountMinor: 3000,
      completedAt: new Date("2026-11-04T10:00:00Z"),
    }]));
    mocks.voucher.mockImplementation(() => query([{
      createdBy: customer, currencySnapshot: "CZK", paidAt: new Date("2026-11-02T12:00:00Z"), expectedAmountMinor: 3000, refundedAmountMinor: 1000,
    }]));
    mocks.invoice.mockImplementation(() => query([{
      user: customer, currency: "CZK", paidAt: new Date("2026-11-02T12:00:00Z"), amountPaidMinor: 4000,
    }]));
    const result = await run();
    expect(result.details.get(customer)).toEqual({ memberNumber: 42, spentMonthMinor: 14000, spentTotalMinor: 19000 });
    expect(result.details.get(second)).toEqual({ memberNumber: null, spentMonthMinor: 0, spentTotalMinor: 0 });
    for (const model of [mocks.order, mocks.refund, mocks.voucher, mocks.invoice])
      for (const [filter] of model.mock.calls) expect(filter.tenant).toBe(tenant);
    expect(mocks.order.mock.calls[0][0]).toMatchObject({ createdBy: { $in: [customer, second] }, isPaid: true });
    expect(mocks.refund.mock.calls[0][0]).toMatchObject({ order: { $in: [orderId, "old", "redemption"] }, status: "succeeded" });
  });
  it("uses the supplied tenant-local month boundary and excludes future receipts", async () => {
    mocks.order.mockImplementation(() => query([
      paidOrder({ _id: "old", paidAt: new Date("2026-10-31T22:59:59Z"), paidAmountMinor: 100 }),
      paidOrder({ _id: "new", paidAt: new Date("2026-10-31T23:00:00Z"), paidAmountMinor: 200 }),
      paidOrder({ _id: "future", paidAt: now, paidAmountMinor: 300 }),
    ]));
    expect((await run()).details.get(customer)).toMatchObject({ spentMonthMinor: 200, spentTotalMinor: 300 });
  });
  it("deducts only succeeded refunds known before the historical cutoff", async () => {
    mocks.order.mockImplementation(() => query([paidOrder()]));
    mocks.refund.mockImplementation(() => query([
      { order: orderId, customer, currency: "CZK", cardAmountMinor: 1000, completedAt: new Date("2026-11-04T00:00:00Z") },
      { order: orderId, customer, currency: "CZK", cardAmountMinor: 2000, completedAt: new Date("2026-11-07T00:00:00Z") },
    ]));
    expect((await run({ asOf: new Date("2026-11-05T00:00:00Z") })).details.get(customer)).toMatchObject({ spentMonthMinor: 9000, spentTotalMinor: 9000 });
  });
  it.each([
    { pieceCheckout: { refundedAmountMinor: 1000 } },
    { waitlistRefund: { status: "succeeded", amountMinor: 1000, lastCheckedAt: new Date("2026-11-04T00:00:00Z") } },
  ])("does not backdate cumulative or reconciliation refund snapshots: %j", async (refund) => {
    mocks.order.mockImplementation(() => query([paidOrder(refund)]));
    expect((await run({ asOf: new Date("2026-11-05T00:00:00Z") })).details.get(customer)?.spentTotalMinor).toBeNull();
    expect((await run()).details.get(customer)?.spentTotalMinor).toBe(9000);
  });
  it("keeps historical voucher refunds and undated membership receipts unavailable", async () => {
    mocks.voucher.mockImplementation(() => query([{
      createdBy: customer, currencySnapshot: "CZK", paidAt: new Date("2026-11-02T00:00:00Z"), expectedAmountMinor: 3000, refundedAmountMinor: 1000,
    }]));
    mocks.invoice.mockImplementation(() => query([{ user: second, currency: "CZK", paidAt: null, amountPaidMinor: 5000 }]));
    const result = await run({ asOf: new Date("2026-11-05T00:00:00Z") });
    expect(result.details.get(customer)?.spentTotalMinor).toBeNull();
    expect(result.details.get(second)?.spentMonthMinor).toBeNull();
    expect(result.details.get(second)?.spentTotalMinor).toBeNull();
  });
  it.each([
    { currency: "EUR" }, { paidAmountMinor: null }, { paidAmountMinor: -1 },
  ])("does not invent or combine uncertain payment amounts: %j", async (overrides) => {
    mocks.order.mockImplementation(() => query([paidOrder(overrides)]));
    const row = (await run()).details.get(customer);
    expect(row?.spentMonthMinor).toBeNull(); expect(row?.spentTotalMinor).toBeNull();
    expect((await run()).details.get(second)?.spentTotalMinor).toBe(0);
  });
  it("retains known current lifetime cash for undated payments without inventing a payment month", async () => {
    mocks.order.mockImplementation(() => query([paidOrder({ paidAt: null })]));
    expect((await run()).details.get(customer)).toMatchObject({ spentMonthMinor: null, spentTotalMinor: 10000 });
    expect((await run({ asOf: new Date("2026-11-05T00:00:00Z") })).details.get(customer)).toMatchObject({ spentMonthMinor: null, spentTotalMinor: null });
  });
  it("does not let an old different-currency payment poison the known current-month amount", async () => {
    mocks.order.mockImplementation(() => query([
      paidOrder(), paidOrder({ _id: "older", currency: "EUR", paidAt: new Date("2026-10-02T00:00:00Z") }),
    ]));
    expect((await run()).details.get(customer)).toMatchObject({ spentMonthMinor: 10000, spentTotalMinor: null });
  });
  it.each([
    { customer: second, completedAt: new Date("2026-11-04T00:00:00Z") },
    { customer, completedAt: null },
    { customer, completedAt: new Date("2026-11-01T00:00:00Z") },
  ])("rejects misattributed or undated confirmed refunds", async (refund) => {
    mocks.order.mockImplementation(() => query([paidOrder()]));
    mocks.refund.mockImplementation(() => query([{ order: orderId, currency: "CZK", cardAmountMinor: 1000, ...refund }]));
    expect((await run()).details.get(customer)?.spentTotalMinor).toBeNull();
  });
  it("fails closed when a source exceeds the bounded read", async () => {
    mocks.order.mockImplementation(() => query(Array.from({ length: 20_001 }, () => paidOrder())));
    const result = await run();
    expect(result.queryLimitExceeded).toBe(true);
    expect(result.details.get(customer)?.spentTotalMinor).toBeNull();
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});


const rank = (overrides: Record<string, unknown> = {}) => getManagementSpendingRanking({
  tenantId: tenant, canRankCustomers: true, enabled: true, currency: "CZK",
  monthStart: new Date("2026-10-31T23:00:00Z"), comparisonStart: new Date("2026-09-30T22:00:00Z"),
  comparisonEnd: new Date("2026-10-08T22:00:00Z"), asOf: now, now, ...overrides,
} as any);

describe("whole-workspace spending ranking and payment aggregates", () => {
  it("ranks spenders without bookings, includes vouchers and memberships, and includes guests only in totals", async () => {
    mocks.user.mockImplementation(() => query([
      { _id: customer, firstname: "Ada", lastname: "A" }, { _id: second, firstname: "Ben" },
    ]));
    mocks.order.mockImplementation(() => query([paidOrder(), paidOrder({ _id: "guest", createdBy: null, paidAmountMinor: 5000 })]));
    mocks.voucher.mockImplementation(() => query([{ createdBy: second, currencySnapshot: "CZK", paidAt: new Date("2026-11-02"), expectedAmountMinor: 8000 }]));
    mocks.invoice.mockImplementation(() => query([{ user: second, currency: "CZK", paidAt: new Date("2026-11-02"), amountPaidMinor: 5000 }]));
    const result = await rank();
    expect(result.items).toMatchObject([{ id: second, revenueMinor: 13000, visits: 0 }, { id: customer, revenueMinor: 10000 }]);
    expect(result.currentPaymentsMinor).toBe(28000);
    expect(result.currentPaymentsComplete).toBe(true);
    for (const model of [mocks.order, mocks.voucher, mocks.invoice, mocks.user])
      expect(model.mock.calls[0][0].tenant).toBe(tenant);
    expect(mocks.user.mock.calls[0][0]).toMatchObject({ tenantRole: "customer" });
    expect(mocks.user.mock.calls[0][0]).not.toHaveProperty("createdAt");
  });
  it("keeps known monthly sums as explicit partial results when undated receipts exist", async () => {
    mocks.order.mockImplementation(() => query([paidOrder(), paidOrder({ _id: "undated", paidAt: null, paidAmountMinor: 4000 })]));
    const result = await rank();
    expect(result.items).toMatchObject([{ revenueMinor: 10000, spentMonthMinor: 10000, spentMonthComplete: false }]);
    expect(result).toMatchObject({ currentPaymentsMinor: 10000, currentPaymentsComplete: false, complete: false, unknownPaymentCount: 1 });
  });
  it("does not present entirely unknown payments as a zero or include future receipts", async () => {
    mocks.order.mockImplementation(() => query([paidOrder({ paidAt: null }), paidOrder({ paidAt: now })]));
    expect(await rank()).toMatchObject({ items: [], currentPaymentsMinor: null, currentPaymentsComplete: false });
  });
  it("keeps finance aggregates without exposing customer identities when customers are denied", async () => {
    mocks.order.mockImplementation(() => query([paidOrder()]));
    expect(await rank({ canRankCustomers: false })).toMatchObject({ currentPaymentsMinor: 10000, items: [], rankingAvailable: false });
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("does not read finance when workspace authorization is missing", async () => {
    expect(await rank({ enabled: false })).toMatchObject({ available: false, currentPaymentsMinor: null });
    for (const model of Object.values(mocks)) expect(model).not.toHaveBeenCalled();
  });
  it("fails closed on bounded financial source reads", async () => {
    mocks.order.mockImplementation(() => query(Array.from({ length: 20001 }, () => paidOrder())));
    expect(await rank()).toMatchObject({ available: false, queryLimitExceeded: true, currentPaymentsMinor: null });
  });
});

it("shows a known monthly subtotal with a field-specific warning while lifetime stays unavailable", async () => {
  mocks.order.mockImplementation(() => query([paidOrder(), paidOrder({ _id: "unknown", paidAt: null, paidAmountMinor: null })]));
  expect((await run()).details.get(customer)).toMatchObject({ spentMonthMinor: 10000, spentMonthComplete: false, spentTotalMinor: null });
});
