import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { PAYMENT_FAILURE_REASON } from "@/modules/tenant-subscription/tenant-subscription.constants.js";
import { getInvoicePaymentRecoveryUpdate } from "@/modules/tenant-subscription/tenant-subscription.payment-recovery.js";

const asInvoice = (overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice =>
  ({
    id: "in_test",
    attempt_count: 1,
    next_payment_attempt: 1_800_000_000,
    hosted_invoice_url: "https://invoice.stripe.com/i/test",
    paid: false,
    status: "open",
    ...overrides,
  }) as Stripe.Invoice;

describe("tenant subscription payment recovery", () => {
  it("captures Stripe's next Smart Retry after a failed attempt", () => {
    const update = getInvoicePaymentRecoveryUpdate(
      "invoice.payment_failed",
      asInvoice(),
    );

    expect(update).toEqual({
      state: "failed",
      attemptCount: 1,
      nextPaymentAttemptAt: new Date(1_800_000_000 * 1000),
      recoveryUrl: "https://invoice.stripe.com/i/test",
      failureReason: PAYMENT_FAILURE_REASON.PAYMENT_FAILED,
    });
  });

  it("refreshes retry scheduling from an open invoice update", () => {
    const update = getInvoicePaymentRecoveryUpdate(
      "invoice.updated",
      asInvoice({ attempt_count: 3, next_payment_attempt: 1_900_000_000 }),
    );

    expect(update?.state).toBe("updated");
    expect(update?.attemptCount).toBe(3);
    expect(update?.nextPaymentAttemptAt).toEqual(
      new Date(1_900_000_000 * 1000),
    );
  });

  it("clears recovery state when the invoice is paid", () => {
    const update = getInvoicePaymentRecoveryUpdate(
      "invoice.paid",
      asInvoice({
        paid: true,
        status: "paid",
        attempt_count: 2,
        next_payment_attempt: null,
      }),
    );

    expect(update).toEqual({ state: "recovered", attemptCount: 2 });
  });

  it("records customer authentication as an actionable failure", () => {
    const update = getInvoicePaymentRecoveryUpdate(
      "invoice.payment_action_required",
      asInvoice({ next_payment_attempt: null }),
    );

    expect(update?.state).toBe("failed");
    expect(update?.failureReason).toBe(PAYMENT_FAILURE_REASON.ACTION_REQUIRED);
    expect(update?.nextPaymentAttemptAt).toBeUndefined();
  });

  it("records the terminal outcome when Stripe stops collecting", () => {
    const update = getInvoicePaymentRecoveryUpdate(
      "invoice.marked_uncollectible",
      asInvoice({ status: "uncollectible", next_payment_attempt: null }),
    );

    expect(update).toEqual({
      state: "terminal",
      attemptCount: 1,
      failureReason: PAYMENT_FAILURE_REASON.MARKED_UNCOLLECTIBLE,
    });
  });
});
