import { describe, expect, it } from "vitest";

import { calculateInvoicePaymentState } from "@/modules/invoice/invoice.payment.js";
import {
  assertIssuedInvoicePaymentTarget,
  assertManualInvoicePaymentReversible,
} from "@/modules/invoice/invoice.service.js";

describe("invoice payment state", () => {
  it("sums active allocations and excludes reversed records", () => {
    expect(
      calculateInvoicePaymentState({
        totalAmountMinor: 10_000,
        allocations: [
          { amountMinor: 2_000, reversedAt: null },
          { amountMinor: 1_500, reversedAt: new Date() },
          { amountMinor: 3_000 },
        ],
      }),
    ).toEqual({
      amountPaidMinor: 5_000,
      amountDueMinor: 5_000,
      paymentStatus: "partially_paid",
    });
  });

  it("reduces due by credit notes without pretending a payment occurred", () => {
    expect(
      calculateInvoicePaymentState({
        totalAmountMinor: 10_000,
        creditedAmountMinor: 4_000,
        allocations: [],
      }),
    ).toEqual({
      amountPaidMinor: 0,
      amountDueMinor: 6_000,
      paymentStatus: "unpaid",
    });
  });

  it("restores the balance when the only payment is reversed", () => {
    const before = calculateInvoicePaymentState({
      totalAmountMinor: 2_500,
      allocations: [{ amountMinor: 2_500, reversedAt: null }],
    });
    const after = calculateInvoicePaymentState({
      totalAmountMinor: 2_500,
      allocations: [{ amountMinor: 2_500, reversedAt: new Date() }],
    });

    expect(before.paymentStatus).toBe("paid");
    expect(before.amountDueMinor).toBe(0);
    expect(after.paymentStatus).toBe("unpaid");
    expect(after.amountDueMinor).toBe(2_500);
  });

  it("rejects overpayment and invalid credited totals", () => {
    expect(() =>
      calculateInvoicePaymentState({
        totalAmountMinor: 1_000,
        allocations: [{ amountMinor: 1_001 }],
      }),
    ).toThrow(/cannot exceed the invoice total/);

    expect(() =>
      calculateInvoicePaymentState({
        totalAmountMinor: 1_000,
        creditedAmountMinor: 1_001,
        allocations: [],
      }),
    ).toThrow(/cannot exceed the invoice total/);
  });

  it("rejects drafts, credit notes, and provider-managed reversals", () => {
    expect(() =>
      assertIssuedInvoicePaymentTarget({
        documentType: "invoice",
        documentStatus: "draft",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVOICE_NOT_ISSUED" }));
    expect(() =>
      assertIssuedInvoicePaymentTarget({
        documentType: "credit_note",
        documentStatus: "issued",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREDIT_NOTE_PAYMENT_NOT_ALLOWED" }),
    );
    expect(() => assertManualInvoicePaymentReversible("stripe")).toThrowError(
      expect.objectContaining({
        code: "INVOICE_PAYMENT_PROVIDER_REVERSAL_NOT_ALLOWED",
      }),
    );
    expect(() => assertManualInvoicePaymentReversible("cash")).not.toThrow();
  });
});
