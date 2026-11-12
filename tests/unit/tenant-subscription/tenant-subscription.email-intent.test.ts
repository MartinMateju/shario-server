import { describe, expect, it } from "vitest";

import { TENANT_BILLING_EMAIL_TYPE } from "@/modules/tenant-subscription/tenant-subscription.email.constants.js";
import { getInvoiceBillingEmailIntent } from "@/modules/tenant-subscription/tenant-subscription.email-intent.js";

describe("tenant billing email intent", () => {
  it("notifies only for the first automatic payment failure", () => {
    const firstAttempt = getInvoiceBillingEmailIntent({
      eventType: "invoice.payment_failed",
      invoiceId: "in_123",
      attemptCount: 1,
      hadPaymentFailure: false,
    });
    const retryAttempt = getInvoiceBillingEmailIntent({
      eventType: "invoice.payment_failed",
      invoiceId: "in_123",
      attemptCount: 2,
      hadPaymentFailure: true,
    });

    expect(firstAttempt?.type).toBe(TENANT_BILLING_EMAIL_TYPE.PAYMENT_FAILED);
    expect(retryAttempt).toBeNull();
  });

  it("deduplicates generic failure and authentication-required notices", () => {
    const failed = getInvoiceBillingEmailIntent({
      eventType: "invoice.payment_failed",
      invoiceId: "in_123",
      attemptCount: 1,
      hadPaymentFailure: false,
    });
    const actionRequired = getInvoiceBillingEmailIntent({
      eventType: "invoice.payment_action_required",
      invoiceId: "in_123",
      attemptCount: 1,
      hadPaymentFailure: true,
    });

    expect(actionRequired?.deliveryKey).toBe(failed?.deliveryKey);
    expect(actionRequired?.priority).toBeGreaterThan(failed?.priority ?? 0);
  });

  it("sends a recovery notice only after a known failure", () => {
    expect(
      getInvoiceBillingEmailIntent({
        eventType: "invoice.paid",
        invoiceId: "in_123",
        attemptCount: 1,
        hadPaymentFailure: false,
      }),
    ).toBeNull();

    expect(
      getInvoiceBillingEmailIntent({
        eventType: "invoice.paid",
        invoiceId: "in_123",
        attemptCount: 2,
        hadPaymentFailure: true,
      })?.type,
    ).toBe(TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERED);
  });

  it("notifies when automatic recovery reaches a terminal invoice state", () => {
    const intent = getInvoiceBillingEmailIntent({
      eventType: "invoice.marked_uncollectible",
      invoiceId: "in_123",
      attemptCount: 8,
      hadPaymentFailure: true,
    });

    expect(intent?.type).toBe(TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERY_ENDED);
  });
});
