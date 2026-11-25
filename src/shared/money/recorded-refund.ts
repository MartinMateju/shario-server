const validMinor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reconciliation is the total provider refund, not an additional refund flow. */
export const applyReconciledRefund = (
  paid: unknown,
  knownNet: number | null,
  summary: any,
  historical: boolean,
): number | null => {
  if (!summary) return knownNet;
  if (
    !validMinor(paid) ||
    knownNet === null ||
    summary.reviewRequired ||
    summary.status === "review" ||
    !validMinor(summary.succeededAmountMinor) ||
    summary.succeededAmountMinor > paid
  )
    return null;
  // A cumulative provider snapshot has no refund-event dates for historical reports.
  if (historical && summary.succeededAmountMinor > 0) return null;
  const specializedRefund = paid - knownNet;
  if (summary.succeededAmountMinor < specializedRefund) return null;
  return paid - summary.succeededAmountMinor;
};
