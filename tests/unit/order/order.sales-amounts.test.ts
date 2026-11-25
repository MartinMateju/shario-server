import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ find: vi.fn(), aggregate: vi.fn(), findExtensions: vi.fn() }));
vi.mock("@/modules/order/order.model.js", () => ({ Order: { find: mocks.findExtensions } }));
vi.mock("@/modules/booking/booking-payment-refund.model.js", () => ({
  BookingPaymentRefund: { find: mocks.find },
}));
vi.mock("@/modules/money-credit/money-credit.model.js", () => ({
  MoneyCredit: { aggregate: mocks.aggregate },
}));

import {
  attachOrderSalesAmounts,
  calculateOrderSalesAmounts,
  SALES_REFUND_ROW_LIMIT,
} from "@/modules/order/order.sales-amounts.js";

const tenant = "64b000000000000000000010";
const orderId = "64b000000000000000000020";
const otherOrderId = "64b000000000000000000021";
const bookingId = "64b000000000000000000030";
const order = (overrides: Record<string, any> = {}) => ({
  _id: orderId, tenant, currency: "CZK", isPaid: true,
  grossAmountMinor: 80000, expectedAmountMinor: 0, paidAmountMinor: 0,
  lineItems: [{ booking: bookingId, grossAmountMinor: 80000 }],
  paymentAllocations: [{ method: "credits", amountMinor: 80000 }],
  cart: { totalPrice: 1000 },
  ...overrides,
});
const credit = (overrides: Record<string, any> = {}) => ({
  _id: "64b000000000000000000040", relatedOrder: orderId,
  relatedBooking: bookingId, currency: "CZK", amountMinor: 20000,
  ...overrides,
});
const paymentRefund = (overrides: Record<string, any> = {}) => ({
  _id: `${tenant}:${orderId}:${bookingId}`, order: orderId,
  booking: bookingId, currency: "CZK", amountMinor: 20000,
  status: "succeeded", ...overrides,
});
const cancellation = { bookingId, refundAmountMinor: 20000, currency: "CZK" };

describe("sales monetary snapshot", () => {
  it("uses discounted immutable order value instead of base cart or external cash", () => {
    expect(calculateOrderSalesAmounts(order())).toEqual({
      status: "available", currency: "CZK", grossAmountMinor: 80000,
      refundedAmountMinor: 0, netAmountMinor: 80000, reason: null,
    });
  });

  it("does not turn missing historical evidence or schema-default zero into free orders", () => {
    for (const candidate of [
      { _id: orderId, isPaid: true, currency: "CZK", cart: { totalPrice: 900 } },
      order({ grossAmountMinor: 0, lineItems: [] }),
    ]) expect(calculateOrderSalesAmounts(candidate)).toMatchObject({
      status: "unavailable", reason: "missing_financial_snapshot", netAmountMinor: null,
    });
  });

  it("accepts an explicitly free zero-price snapshot", () => {
    expect(calculateOrderSalesAmounts(order({
      grossAmountMinor: 0, lineItems: [{ grossAmountMinor: 0 }],
      paymentAllocations: [{ method: "free", amountMinor: 0 }],
    }))).toMatchObject({ status: "available", netAmountMinor: 0 });
  });

  it.each([
    { grossAmountMinor: 10.5 }, { grossAmountMinor: -1 },
    { grossAmountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { grossAmountMinor: "80000" },
    { lineItems: [{ grossAmountMinor: 100000 }] },
    { lineItems: [{ grossAmountMinor: NaN }] },
  ])("rejects inconsistent or unsafe snapshot %j", (snapshot) => {
    expect(calculateOrderSalesAmounts(order(snapshot))).toMatchObject({ status: "unavailable", netAmountMinor: null });
  });

  it("does not assume a missing currency is CZK", () => {
    expect(calculateOrderSalesAmounts(order({ currency: undefined }))).toMatchObject({
      status: "unavailable", currency: null, reason: "missing_currency",
    });
  });

  it("keeps non-monetary member benefit redemption unavailable", () => {
    expect(calculateOrderSalesAmounts(order({
      paymentAllocations: [{ method: "membership_credit", amountMinor: 80000 }],
    }))).toMatchObject({ status: "unavailable", reason: "non_monetary_payment" });
    expect(calculateOrderSalesAmounts(order({
      paymentAllocations: [], membershipRedemption: { ledgerEntryId: "known-entitlement" },
    }))).toMatchObject({ status: "unavailable", reason: "non_monetary_payment" });
  });

  it("deducts an Open Studio refund recorded only in MoneyCredit", () => {
    expect(calculateOrderSalesAmounts(order(), { creditRefunds: [credit()] }))
      .toMatchObject({ grossAmountMinor: 80000, refundedAmountMinor: 20000, netAmountMinor: 60000 });
  });

  it("converts an explicit legacy credit amount with its currency, including zero-decimal money", () => {
    expect(calculateOrderSalesAmounts(order({ currency: "JPY" }), {
      creditRefunds: [credit({ currency: "JPY", amountMinor: null, amount: 250 })],
    })).toMatchObject({ refundedAmountMinor: 250, netAmountMinor: 79750 });
  });

  it("deduplicates course cancellation snapshot and its completed credit transaction", () => {
    expect(calculateOrderSalesAmounts(order({ courseCancellations: [cancellation] }), {
      creditRefunds: [credit()],
    })).toMatchObject({ refundedAmountMinor: 20000, netAmountMinor: 60000 });
  });

  it("deduplicates voucher/card course cancellation and original payment refund", () => {
    expect(calculateOrderSalesAmounts(order({
      paymentAllocations: [{ method: "voucher", amountMinor: 80000 }],
      courseCancellations: [cancellation],
    }), { paymentRefunds: [paymentRefund()] }))
      .toMatchObject({ refundedAmountMinor: 20000, netAmountMinor: 60000 });
  });

  it("recognizes atomic historical credit cancellation snapshots", () => {
    expect(calculateOrderSalesAmounts(order({ courseCancellations: [cancellation] })))
      .toMatchObject({ refundedAmountMinor: 20000, netAmountMinor: 60000 });
  });

  it("does not claim a voucher return completed when its refund record is missing", () => {
    expect(calculateOrderSalesAmounts(order({
      paymentAllocations: [{ method: "voucher", amountMinor: 80000 }],
      courseCancellations: [cancellation],
    }))).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
    expect(calculateOrderSalesAmounts(order({
      paymentAllocations: [], voucherRedemptions: [{ amountMinor: 80000 }],
      courseCancellations: [cancellation],
    }))).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
  });

  it.each(["pending", "processing", "provider_pending", "review_required"])(
    "does not present a verified net total for a %s refund", (status) => {
      expect(calculateOrderSalesAmounts(order(), {
        paymentRefunds: [paymentRefund({ status })],
      })).toMatchObject({ status: "unavailable", reason: "refund_pending_or_review" });
    },
  );

  it.each([
    { creditRefunds: [credit({ currency: "EUR" })] },
    { creditRefunds: [credit({ amountMinor: -1 })] },
    { creditRefunds: [credit({ amountMinor: null, amount: 0.001 })] },
    { creditRefunds: [credit({ relatedOrder: null })] },
    { creditRefunds: [credit(), credit({ _id: "different" })] },
    { creditRefunds: [credit()], paymentRefunds: [paymentRefund()] },
  ])("rejects ambiguous refund evidence %j", (evidence) => {
    expect(calculateOrderSalesAmounts(order(), evidence)).toMatchObject({ status: "unavailable", netAmountMinor: null });
  });

  it("rejects conflicting cancellation and ledger values", () => {
    expect(calculateOrderSalesAmounts(order({ courseCancellations: [cancellation] }), {
      creditRefunds: [credit({ amountMinor: 30000 })],
    })).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
  });

  it("rejects original-payment and cancellation snapshots assigned outside the immutable booking lines", () => {
    expect(calculateOrderSalesAmounts(order(), {
      paymentRefunds: [paymentRefund({ booking: "other-booking" })],
    })).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
    expect(calculateOrderSalesAmounts(order({
      grossAmountMinor: 100000,
      lineItems: [{ booking: bookingId, grossAmountMinor: 50000 }, { booking: "other", grossAmountMinor: 50000 }],
      courseCancellations: [{ ...cancellation, refundAmountMinor: 60000 }],
    }))).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
  });

  it("does not mix another customer's cancellation in the same Class", () => {
    expect(calculateOrderSalesAmounts(order(), {
      creditRefunds: [credit({ relatedOrder: otherOrderId })],
      paymentRefunds: [paymentRefund({ order: otherOrderId })],
    })).toMatchObject({ status: "available", refundedAmountMinor: 0 });
  });

  it("marks a combined extension refund unavailable for every affected extension order", () => {
    const extension = order({ bookingExtension: { bookingId, amountMinor: 80000 } });
    expect(calculateOrderSalesAmounts(extension, {
      creditRefunds: [credit({ amountMinor: 100000 })],
    })).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
    expect(calculateOrderSalesAmounts({ ...extension, _id: otherOrderId }, {
      creditRefunds: [credit({ amountMinor: 100000 })],
    })).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
  });

  it("does not attribute a combined extension refund even when below order gross", () => {
    expect(calculateOrderSalesAmounts(order({ bookingExtension: { bookingId, amountMinor: 80000 } }), {
      creditRefunds: [credit({ amountMinor: 20000 })],
    })).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
    expect(calculateOrderSalesAmounts(order(), {
      creditRefunds: [credit({ amountMinor: 20000 })], extensionBookingIds: [bookingId],
    })).toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
  });

  it("rejects a refund above its booking line even when below a multi-booking order total", () => {
    expect(calculateOrderSalesAmounts(order({
      grossAmountMinor: 100000,
      lineItems: [{ booking: bookingId, grossAmountMinor: 50000 }, { booking: "other", grossAmountMinor: 50000 }],
    }), { creditRefunds: [credit({ amountMinor: 60000 })] }))
      .toMatchObject({ status: "unavailable", reason: "refund_allocation_unavailable" });
  });

  it.each([
    { pieceCheckout: { state: "refunded", refundedAmountMinor: 20000 } },
    { waitlistRefund: { status: "succeeded", refundId: "re_1", amountMinor: 20000 } },
    { expectedAmountMinor: 20000, bookingExtension: { bookingId, refundStatus: "succeeded", refundId: "re_1" } },
  ])("deducts completed special refund %j", (snapshot) => {
    expect(calculateOrderSalesAmounts(order(snapshot)))
      .toMatchObject({ status: "available", refundedAmountMinor: 20000, netAmountMinor: 60000 });
  });

  it("does not double count overlapping refund channels or clamp excess refunds", () => {
    expect(calculateOrderSalesAmounts(order({
      pieceCheckout: { state: "refunded", refundedAmountMinor: 20000 },
    }), { creditRefunds: [credit()] })).toMatchObject({ status: "unavailable" });
    expect(calculateOrderSalesAmounts(order(), { creditRefunds: [credit({ amountMinor: 90000 })] }))
      .toMatchObject({ status: "unavailable" });
  });
});

describe("scoped sales refund reads", () => {
  let query: any;
  beforeEach(() => {
    vi.clearAllMocks();
    query = { select: vi.fn(), limit: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue([]) };
    query.select.mockReturnValue(query); query.limit.mockReturnValue(query); query.lean.mockReturnValue(query);
    mocks.find.mockReturnValue(query);
    const extensionQuery = { select: vi.fn(), limit: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue([]) };
    extensionQuery.select.mockReturnValue(extensionQuery); extensionQuery.limit.mockReturnValue(extensionQuery);
    extensionQuery.lean.mockReturnValue(extensionQuery); mocks.findExtensions.mockReturnValue(extensionQuery);
    mocks.aggregate.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });
  });

  it("scopes both ledgers to tenant and authorized page IDs, with row caps", async () => {
    const result = await attachOrderSalesAmounts(tenant, [order()]);
    expect(result[0].salesAmounts.status).toBe("available");
    const filter = mocks.find.mock.calls[0][0];
    expect(String(filter.tenant)).toBe(tenant);
    expect(filter.order.$in.map(String)).toEqual([orderId]);
    expect(query.limit).toHaveBeenCalledWith(SALES_REFUND_ROW_LIMIT + 1);
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(String(pipeline[0].$match.tenant)).toBe(tenant);
    expect(pipeline[0].$match["transactions.type"]).toBe("refund");
    expect(pipeline[0].$match.$or[0]["transactions.relatedOrder"].$in.map(String)).toEqual([orderId]);
    expect(pipeline.at(-1)).toEqual({ $limit: SALES_REFUND_ROW_LIMIT + 1 });
    expect(pipeline[4].$project).not.toHaveProperty("user");
    const extensionFilter = mocks.findExtensions.mock.calls[0][0];
    expect(String(extensionFilter.tenant)).toBe(tenant);
    expect(extensionFilter["bookingExtension.bookingId"].$in.map(String)).toEqual([bookingId]);
  });

  it("skips ledger reads for empty pages and missing monetary snapshots", async () => {
    expect(await attachOrderSalesAmounts(tenant, [])).toEqual([]);
    expect((await attachOrderSalesAmounts(tenant, [{ _id: orderId }]))[0].salesAmounts.status).toBe("unavailable");
    expect(mocks.find).not.toHaveBeenCalled(); expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("isolates malformed historical booking IDs instead of failing the page", async () => {
    const result = await attachOrderSalesAmounts(tenant, [
      order({ lineItems: [{ booking: "legacy-booking-42", grossAmountMinor: 80000 }] }),
      order({ _id: otherOrderId }),
    ]);
    expect(result[0].salesAmounts).toMatchObject({ status: "unavailable", reason: "invalid_financial_snapshot" });
    expect(result[1].salesAmounts.status).toBe("available");
    expect(mocks.find.mock.calls[0][0].order.$in.map(String)).toEqual([otherOrderId]);
  });

  it("keeps failures and capped evidence unavailable rather than showing zero refunds", async () => {
    query.exec.mockRejectedValueOnce(new Error("ledger unavailable"));
    expect((await attachOrderSalesAmounts(tenant, [order()]))[0].salesAmounts)
      .toMatchObject({ status: "unavailable", reason: "refund_lookup_failed", netAmountMinor: null });
    query.exec.mockResolvedValueOnce(Array(SALES_REFUND_ROW_LIMIT + 1).fill(paymentRefund()));
    expect((await attachOrderSalesAmounts(tenant, [order()]))[0].salesAmounts)
      .toMatchObject({ status: "unavailable", reason: "refund_query_limit", netAmountMinor: null });
  });
});
