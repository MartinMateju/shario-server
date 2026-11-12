import type Stripe from "stripe";

import { PAYMENT_FAILURE_REASON } from "./tenant-subscription.constants.js";
import type { PaymentFailureReason } from "./tenant-subscription.types.js";

export type InvoicePaymentRecoveryUpdate = {
  state: "failed" | "recovered" | "updated" | "terminal";
  attemptCount: number;
  nextPaymentAttemptAt?: Date;
  recoveryUrl?: string;
  failureReason?: PaymentFailureReason;
};

const dateFromSeconds = (value: number | null | undefined): Date | undefined =>
  value ? new Date(value * 1000) : undefined;

const getRecoveryFields = (
  invoice: Stripe.Invoice,
): Pick<
  InvoicePaymentRecoveryUpdate,
  "attemptCount" | "nextPaymentAttemptAt" | "recoveryUrl"
> => ({
  attemptCount: Math.max(0, invoice.attempt_count ?? 0),
  nextPaymentAttemptAt: dateFromSeconds(invoice.next_payment_attempt),
  recoveryUrl:
    invoice.status === "open"
      ? (invoice.hosted_invoice_url ?? undefined)
      : undefined,
});

/**
 * Converts Stripe invoice events into the recovery state stored locally.
 * Stripe remains responsible for deciding when Smart Retries run.
 */
export const getInvoicePaymentRecoveryUpdate = (
  eventType: string,
  invoice: Stripe.Invoice,
): InvoicePaymentRecoveryUpdate | null => {
  const recoveryFields = getRecoveryFields(invoice);

  if (
    eventType === "invoice.paid" ||
    eventType === "invoice.payment_succeeded"
  ) {
    return {
      state: "recovered",
      attemptCount: recoveryFields.attemptCount,
    };
  }

  const failedEventReasons: Record<string, PaymentFailureReason> = {
    "invoice.payment_failed": PAYMENT_FAILURE_REASON.PAYMENT_FAILED,
    "invoice.payment_action_required": PAYMENT_FAILURE_REASON.ACTION_REQUIRED,
    "invoice.finalization_failed": PAYMENT_FAILURE_REASON.FINALIZATION_FAILED,
  };
  const failureReason = failedEventReasons[eventType];

  if (failureReason) {
    return {
      state: "failed",
      ...recoveryFields,
      failureReason,
    };
  }

  if (eventType === "invoice.marked_uncollectible") {
    return {
      state: "terminal",
      attemptCount: recoveryFields.attemptCount,
      failureReason: PAYMENT_FAILURE_REASON.MARKED_UNCOLLECTIBLE,
    };
  }

  if (eventType === "invoice.voided") {
    return {
      state: "terminal",
      attemptCount: recoveryFields.attemptCount,
      failureReason: PAYMENT_FAILURE_REASON.VOIDED,
    };
  }

  if (eventType === "invoice.updated") {
    if (invoice.paid || invoice.status === "paid") {
      return {
        state: "recovered",
        attemptCount: recoveryFields.attemptCount,
      };
    }

    if (
      invoice.status === "open" &&
      (recoveryFields.attemptCount > 0 || recoveryFields.nextPaymentAttemptAt)
    ) {
      return {
        state: "updated",
        ...recoveryFields,
      };
    }
  }

  return null;
};
