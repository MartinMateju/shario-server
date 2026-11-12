import { describe, expect, it } from "vitest";
import { getRecordedOrderCash } from "@/modules/user/services/user.directory-metrics.service.js";

const order = {
  createdBy: "customer",
  currency: "CZK",
  paidAmountMinor: 10000,
};
describe("recorded customer cash", () => {
  it("subtracts external card refunds, not wallet or voucher reversals", () => {
    expect(
      getRecordedOrderCash({
        ...order,
        courseCancellations: [{ refundAmountMinor: 9000 }],
        cashRefunds: [
          {
            customer: "customer",
            currency: "CZK",
            amountMinor: 5000,
            cardAmountMinor: 3000,
            voucherAmountMinor: 2000,
          },
        ],
      }),
    ).toBe(7000);
    expect(getRecordedOrderCash({ ...order, paidAmountMinor: 0 })).toBe(0);
  });

  it("handles cumulative piece and succeeded waitlist refunds once", () => {
    expect(
      getRecordedOrderCash({
        ...order,
        pieceCheckout: { refundedAmountMinor: 3000 },
      }),
    ).toBe(7000);
    expect(
      getRecordedOrderCash({
        ...order,
        waitlistRefund: { status: "succeeded", amountMinor: 10000 },
      }),
    ).toBe(0);
    expect(
      getRecordedOrderCash({
        ...order,
        waitlistRefund: { status: "pending", amountMinor: 10000 },
      }),
    ).toBe(10000);
  });

  it.each([null, undefined, "100", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not invent a payment from invalid amount %s",
    (amount) => {
      expect(
        getRecordedOrderCash({
          ...order,
          paidAmountMinor: amount,
          grossAmountMinor: 10000,
        }),
      ).toBeNull();
    },
  );

  it("rejects conflicting refund amounts, currencies and customer attribution", () => {
    for (const overrides of [
      { pieceCheckout: { refundedAmountMinor: 10001 } },
      {
        pieceCheckout: { refundedAmountMinor: 3000 },
        waitlistRefund: { status: "succeeded", amountMinor: 1000 },
      },
      {
        cashRefunds: [
          { customer: "different", currency: "CZK", cardAmountMinor: 100 },
        ],
      },
      {
        cashRefunds: [
          { customer: "customer", currency: "EUR", cardAmountMinor: 100 },
        ],
      },
      { currency: null },
    ])
      expect(getRecordedOrderCash({ ...order, ...overrides })).toBeNull();
  });
});
