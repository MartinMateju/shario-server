import { describe, expect, it } from "vitest";
import { calculateManagementPayments } from "@/modules/dashboard/dashboard-management.payments.js";
const now = new Date("2026-11-16T12:00:00Z");
const paidAt = new Date("2026-11-02T12:00:00Z");
const order = { _id: "o", createdBy: "c", currency: "CZK", paidAmountMinor: 10000, paidAt };
const summary = (amount: number, extra: any = {}) => ({ status: "partial", succeededAmountMinor: amount, reviewRequired: false, ...extra });
const run = (args: any = {}) => calculateManagementPayments({ orders: [], vouchers: [], invoices: [], refunds: [],
  currency: "CZK", periodStart: new Date("2026-10-31T23:00:00Z"), asOf: now, now, ...args });

describe("verified payment subtotals", () => {
  it("deducts a reconciled refund once even when the same refund has specialized booking evidence", () => {
    expect(run({ orders: [{ ...order, refund: summary(2000) }], refunds: [{ order: "o", customer: "c", currency: "CZK",
      cardAmountMinor: 2000, completedAt: new Date("2026-11-03") }] })).toMatchObject({ periodMinor: 8000, complete: true });
  });
  it("deducts additional generic provider refunds and refunds on membership invoices", () => {
    expect(run({ orders: [{ ...order, refund: summary(4000) }], invoices: [{ user: "member", currency: "CZK", paidAt,
      amountPaidMinor: 3000, refund: summary(1000) }] })).toMatchObject({ periodMinor: 8000 });
  });
  it("keeps unknown or conflicting refund summaries out of the known subtotal", () => {
    expect(run({ orders: [{ ...order, refund: summary(1000) }], refunds: [{ order: "o", customer: "c", currency: "CZK",
      cardAmountMinor: 2000, completedAt: new Date("2026-11-03") }] })).toMatchObject({ periodMinor: null, knownPeriodMinor: 0 });
    expect(run({ orders: [{ ...order, refund: summary(1000, { reviewRequired: true }) }] })).toMatchObject({ complete: false });
  });
  it("does not backdate cumulative refund snapshots", () => {
    expect(run({ orders: [{ ...order, refund: summary(2000) }], asOf: new Date("2026-11-10") }))
      .toMatchObject({ periodMinor: null, unknownPaymentCount: 1 });
  });
  it("keeps prior-period uncertainty out of current payments and includes unidentified customers", () => {
    expect(run({ orders: [{ ...order, createdBy: null }, { ...order, _id: "old", paidAt: new Date("2026-10-01"), paidAmountMinor: null }] }))
      .toMatchObject({ periodMinor: 10000, knownPeriodMinor: 10000, complete: true });
  });
  it("keeps a partial known amount without inventing dates for undated receipts or double-counting redemption", () => {
    expect(run({ orders: [order, { ...order, _id: "unknown", paidAt: null }, { ...order, _id: "redemption", paidAmountMinor: 0 }] }))
      .toMatchObject({ periodMinor: null, knownPeriodMinor: 10000, unknownPaymentCount: 1 });
  });
});
