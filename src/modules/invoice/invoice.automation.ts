import { INVOICE_DOCUMENT_STATUS, INVOICE_SOURCE_KIND } from "./invoice.constants.js";

export const INVOICE_AUTOMATION_RETRY_DELAY_MS = 30 * 60 * 1000;

export const buildInvoiceAutomationFailureState = (
  error: unknown,
  now = new Date(),
) => ({
  lastAttemptAt: now,
  nextAttemptAt: new Date(now.getTime() + INVOICE_AUTOMATION_RETRY_DELAY_MS),
  lastError: (error instanceof Error ? error.message : String(error || "failed")).slice(
    0,
    2000,
  ),
});

const retryDueFilter = (path: string, now: Date) => ({
  $or: [
    { [path]: { $exists: false } },
    { [path]: null },
    { [path]: { $lte: now } },
  ],
});

export const buildActionablePaidOrderInvoiceFilter = ({
  now,
  disabledTenantIds,
}: {
  now: Date;
  disabledTenantIds: readonly string[];
}) => ({
  isPaid: true,
  status: "processed_order" as const,
  tenant: {
    // Legacy/orphan orders without a tenant cannot be invoiced safely and
    // previously became String(undefined) in the reconciliation worker.
    $type: "objectId" as const,
    ...(disabledTenantIds.length
      ? { $nin: [...disabledTenantIds] }
      : {}),
  },
  $and: [
    { $or: [{ invoice: null }, { invoice: { $exists: false } }] },
    retryDueFilter("invoiceAutomation.nextAttemptAt", now),
  ],
});

export const buildActionableAutomaticInvoiceFilter = ({
  now,
  finalizeTenantIds,
  sendTenantIds,
}: {
  now: Date;
  finalizeTenantIds: readonly string[];
  sendTenantIds: readonly string[];
}) => {
  const stages: Record<string, unknown>[] = [];
  if (finalizeTenantIds.length) {
    stages.push({
      tenant: { $in: [...finalizeTenantIds] },
      documentStatus: INVOICE_DOCUMENT_STATUS.DRAFT,
    });
  }
  if (sendTenantIds.length) {
    stages.push({
      tenant: { $in: [...sendTenantIds] },
      documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
      sentAt: null,
    });
  }
  if (!stages.length) return null;

  return {
    automatic: true,
    requiresReview: { $ne: true },
    "source.kind": INVOICE_SOURCE_KIND.ORDER,
    $and: [
      retryDueFilter("automationNextAttemptAt", now),
      { $or: stages },
    ],
  };
};
