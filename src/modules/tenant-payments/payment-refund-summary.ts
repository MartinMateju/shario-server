/** Serialize only financial status. Provider IDs and staff notes stay private. */
export const serializeRefundSummary = (summary: any) => summary ? ({
  reconciliationId: summary.reconciliationId, status: summary.status,
  succeededAmountMinor: summary.succeededAmountMinor, pendingAmountMinor: summary.pendingAmountMinor,
  failedAmountMinor: summary.failedAmountMinor, reviewRequired: summary.reviewRequired,
  reviewReason: summary.reviewReason, snapshotVersion: summary.snapshotVersion, updatedAt: summary.updatedAt,
}) : null;

export const hasRecordedPaymentRefund = (summary: any): boolean => Boolean(summary &&
  (summary.reviewRequired || summary.succeededAmountMinor > 0 || summary.pendingAmountMinor > 0 || summary.status === "review"));
