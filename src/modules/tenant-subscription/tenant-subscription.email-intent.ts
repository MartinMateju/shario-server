import { TENANT_BILLING_EMAIL_TYPE } from "./tenant-subscription.email.constants.js";
import type { TenantBillingEmailIntent } from "./tenant-subscription.email.types.js";

const invoiceDeliveryKey = (invoiceId: string, notification: string): string =>
  `tenant-billing:invoice:${invoiceId}:${notification}`;

export const getInvoiceBillingEmailIntent = ({
  eventType,
  invoiceId,
  attemptCount,
  hadPaymentFailure,
}: {
  eventType: string;
  invoiceId: string;
  attemptCount: number;
  hadPaymentFailure: boolean;
}): TenantBillingEmailIntent | null => {
  if (eventType === "invoice.payment_failed" && attemptCount <= 1) {
    return {
      type: TENANT_BILLING_EMAIL_TYPE.PAYMENT_FAILED,
      deliveryKey: invoiceDeliveryKey(invoiceId, "payment-attention"),
      priority: 10,
    };
  }

  if (eventType === "invoice.payment_action_required") {
    return {
      type: TENANT_BILLING_EMAIL_TYPE.PAYMENT_ACTION_REQUIRED,
      deliveryKey: invoiceDeliveryKey(invoiceId, "payment-attention"),
      priority: 20,
    };
  }

  if (eventType === "invoice.finalization_failed") {
    return {
      type: TENANT_BILLING_EMAIL_TYPE.INVOICE_FINALIZATION_FAILED,
      deliveryKey: invoiceDeliveryKey(invoiceId, "finalization-failed"),
      priority: 20,
    };
  }

  if (
    hadPaymentFailure &&
    (eventType === "invoice.paid" || eventType === "invoice.payment_succeeded")
  ) {
    return {
      type: TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERED,
      deliveryKey: invoiceDeliveryKey(invoiceId, "payment-recovered"),
      priority: 10,
    };
  }

  if (
    hadPaymentFailure &&
    (eventType === "invoice.marked_uncollectible" ||
      eventType === "invoice.voided")
  ) {
    return {
      type: TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERY_ENDED,
      deliveryKey: invoiceDeliveryKey(invoiceId, "payment-recovery-ended"),
      priority: 20,
    };
  }

  return null;
};

export const getTrialEndingBillingEmailIntent = ({
  subscriptionId,
  trialEndsAt,
}: {
  subscriptionId: string;
  trialEndsAt: Date;
}): TenantBillingEmailIntent => ({
  type: TENANT_BILLING_EMAIL_TYPE.TRIAL_ENDING,
  deliveryKey: `tenant-billing:subscription:${subscriptionId}:trial-ending:${trialEndsAt.toISOString()}`,
  priority: 10,
});
