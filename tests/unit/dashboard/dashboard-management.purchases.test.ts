import { describe, expect, it } from "vitest";
import { calculateManagementPurchases } from "@/modules/dashboard/dashboard-management.purchases.js";
import { resolveManagementPeriods } from "@/modules/dashboard/dashboard-management.calculations.js";
const now = new Date("2026-11-16T12:00:00Z");
const period = resolveManagementPeriods(undefined, "Europe/Prague", now).arrivals;
const line = (product: string, quantity = 1) => ({ product, quantity, description: product, locationIds: ["a"] });
const order = (overrides: any = {}) => ({ _id: "order", status: "processed_order", isPaid: true,
  paidAt: new Date("2026-11-01T10:00:00Z"), lineItems: [line("mug")], ...overrides });
const run = (orders: any[], extra: any = {}) => calculateManagementPurchases({ orders, period, asOf: now, now,
  locationIds: ["a"], wholeTenant: false, ...extra });

describe("paid product purchases in the independent last-30-days window", () => {
  it("counts purchase orders separately from units without requiring a completed booking", () => {
    const result = run([
      order({ lineItems: [line("mug", 3), line("mug", 2), line("plate")] }),
      order({ _id: "second", paidAt: new Date("2026-10-20T10:00:00Z"), lineItems: [line("mug"), line("plate")] }),
      order({ _id: "third", lineItems: [line("plate")] }),
    ]);
    expect(result).toMatchObject({ complete: true, items: [
      { id: "plate", purchaseCount: 3, quantity: 3 }, { id: "mug", purchaseCount: 2, quantity: 6 },
    ] });
  });
  it("uses the tenant-local rolling boundary and excludes unpaid, pending, cancelled and future purchases", () => {
    const result = run([
      order({ paidAt: new Date("2026-10-17T21:59:59Z") }),
      order({ _id: "boundary", paidAt: new Date("2026-10-17T22:00:00Z") }),
      order({ status: "pending_order" }), order({ status: "cancelled_order" }),
      order({ isPaid: false }), order({ paidAt: now }),
    ]);
    expect(result.items).toMatchObject([{ id: "mug", purchaseCount: 1, quantity: 1 }]);
  });
  it("excludes stored-value topups and fully refunded purchases but counts settled redemption purchases", () => {
    const result = run([
      order({ creditPurchase: { amount: 100 }, lineItems: [] }), order({ refund: { status: "full", succeededAmountMinor: 100 } }),
      order({ pieceCheckout: { state: "refunded" } }), order({ paidAmountMinor: 0 }),
    ]);
    expect(result.items).toMatchObject([{ purchaseCount: 1 }]);
  });
  it("removes cancelled course quantities once across repeated lines and retains only surviving purchases", () => {
    const result = run([order({ lineItems: [{ ...line("class", 2), booking: "b" }, { ...line("class", 1), booking: "b" }],
      courseCancellations: [{ bookingId: "b", quantity: 2, refundedAt: new Date("2026-11-10") }] }),
      order({ _id: "cancelled", lineItems: [{ ...line("class"), booking: "c" }],
        courseCancellations: [{ bookingId: "c", quantity: 1, refundedAt: new Date("2026-11-10") }] }),
    ]);
    expect(result.items).toMatchObject([{ id: "class", purchaseCount: 1, quantity: 1 }]);
  });
  it("does not leak other studio lines and labels missing allocation or identity evidence partial", () => {
    const result = run([order({ lineItems: [line("mug"), { ...line("other"), locationIds: ["b"] },
      { ...line("shared"), locationIds: ["a", "b"] }, { ...line("unknown"), product: null }] })]);
    expect(result.complete).toBe(false);
    expect(result.items).toMatchObject([{ id: "mug" }]);
  });
  it("marks historical and partial cumulative refunds incomplete instead of inventing product allocation", () => {
    expect(run([order({ refund: { status: "full", succeededAmountMinor: 100 } })], {
      asOf: new Date("2026-11-15T12:00:00Z"),
    })).toEqual({ complete: false, items: [] });
    expect(run([order({ refund: { status: "partial", succeededAmountMinor: 20 } })]))
      .toMatchObject({ complete: false, items: [{ purchaseCount: 1 }] });
  });
  it("marks unknown dates and legacy lines unavailable rather than silently reporting a complete zero", () => {
    expect(run([order({ paidAt: null }), order({ lineItems: [] })])).toEqual({ complete: false, items: [] });
  });
});


it("includes catalog credit packs while excluding generic wallet topups without a Product", () => {
  expect(run([order({ creditPurchase: { amount: 1000 }, lineItems: [line("credit-pack")] }),
    order({ creditPurchase: { amount: 1000 }, lineItems: [{ description: "Wallet topup", quantity: 1 }] }),
  ])).toMatchObject({ complete: true, items: [{ id: "credit-pack", purchaseCount: 1 }] });
});

const voucher = (overrides: any = {}) => ({ status: "processed_coupon", paidAt: new Date("2026-11-01T10:00:00Z"),
  product: "voucher", productNameSnapshot: "Gift voucher", quantity: 2, expectedAmountMinor: 10000, ...overrides });
it("counts standalone voucher product purchases and combines their Product identity with ordinary orders", () => {
  const result = run([order({ lineItems: [line("voucher")] })], { wholeTenant: true,
    vouchers: [voucher(), voucher({ status: "shipped_coupon", quantity: 1 })] });
  expect(result).toMatchObject({ complete: true, items: [{ id: "voucher", purchaseCount: 3, quantity: 4 }] });
});
it("does not attribute workspace vouchers to a branch or count unpaid/refunded voucher purchases", () => {
  expect(run([], { vouchers: [voucher()] })).toEqual({ complete: false, items: [] });
  expect(run([], { wholeTenant: true, vouchers: [
    voucher({ status: "pending_coupon_payment" }), voucher({ refundedAmountMinor: 10000 }), voucher({ refundState: "revoked" }),
    voucher({ paidAt: now }), voucher({ paidAt: new Date("2026-10-01") }),
  ] })).toEqual({ complete: true, items: [] });
});
it("labels missing voucher purchase data and unallocated refunds incomplete", () => {
  expect(run([], { wholeTenant: true, vouchers: [voucher({ paidAt: null }), voucher({ quantity: 0 }),
    voucher({ product: null }), voucher({ refundFailureReviewRequired: true })] })).toEqual({ complete: false, items: [] });
  expect(run([], { wholeTenant: true, vouchers: [voucher({ refundedAmountMinor: 1000 })] }))
    .toMatchObject({ complete: false, items: [{ purchaseCount: 1 }] });
  expect(run([], { wholeTenant: true, asOf: new Date("2026-11-15"), vouchers: [voucher({ refundedAmountMinor: 10000 })] }))
    .toEqual({ complete: false, items: [] });
});
