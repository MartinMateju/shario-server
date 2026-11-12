export type TimeBucketKind = "period" | "carryover" | "adjustment";
export type TimeBucket = {
  key: string;
  periodKey: string;
  kind: TimeBucketKind;
  available: number;
  expiresAt: Date;
};
export type TimeAllocation = Omit<TimeBucket, "available"> & { amount: number };

export const isTimeAllowance = (benefit: any): boolean =>
  benefit?.type === "allowance" && ["minute", "hour"].includes(benefit.unit);

export const copyTimeBuckets = (balance: any): TimeBucket[] =>
  (balance?.timeBuckets ?? []).map((bucket: any) => ({
    key: String(bucket.key), periodKey: String(bucket.periodKey), kind: bucket.kind,
    available: Number(bucket.available), expiresAt: new Date(bucket.expiresAt),
  }));

export const availableCurrentPeriod = (balance: any): number =>
  copyTimeBuckets(balance).filter((bucket) =>
    bucket.kind === "period" && bucket.periodKey === balance.timePeriodKey,
  ).reduce((sum, bucket) => sum + bucket.available, 0);

export const calculateTimeCarryover = (balance: any, benefit: any, periodStart: Date): number => {
  if (!balance?.timeBucketVersion || !balance.timePeriodEnd ||
      new Date(balance.timePeriodEnd).getTime() !== periodStart.getTime()) return 0;
  const percent = Math.max(0, Math.min(25, Number(benefit.rolloverPercent ?? 0)));
  const unused = balance.rolloverCandidateAvailable == null
    ? availableCurrentPeriod(balance) : Number(balance.rolloverCandidateAvailable);
  return Math.max(0, Math.min(unused,
    Math.floor(Number(balance.timeGrantQuantity ?? 0) * percent / 100)));
};

/** Spend carried hours first; adjustments never become next month's carry. */
export const consumeTimeBuckets = (
  original: TimeBucket[], amount: number, now: Date, allowExpired = false,
): { buckets: TimeBucket[]; allocations: TimeAllocation[] } => {
  const buckets = original.map((bucket) => ({ ...bucket }));
  const order = buckets.slice().sort((a, b) =>
    a.expiresAt.getTime() - b.expiresAt.getTime() ||
    (a.kind === "carryover" ? -1 : b.kind === "carryover" ? 1 : 0),
  );
  let remaining = amount;
  const allocations: TimeAllocation[] = [];
  for (const bucket of order) {
    if (!remaining) break;
    if (!allowExpired && bucket.expiresAt <= now) continue;
    const used = Math.min(remaining, bucket.available);
    if (!used) continue;
    bucket.available -= used;
    remaining -= used;
    allocations.push({ key: bucket.key, periodKey: bucket.periodKey,
      kind: bucket.kind, amount: used, expiresAt: bucket.expiresAt });
  }
  if (remaining) throw new Error("Insufficient unexpired membership time balance.");
  return { buckets, allocations };
};

export const restoreTimeBuckets = (original: TimeBucket[], allocations: TimeAllocation[]): TimeBucket[] => {
  const buckets = original.map((bucket) => ({ ...bucket }));
  for (const allocation of allocations) {
    let bucket = buckets.find((candidate) => candidate.key === allocation.key);
    if (!bucket) {
      bucket = { key: allocation.key, periodKey: allocation.periodKey, kind: allocation.kind,
        available: 0, expiresAt: new Date(allocation.expiresAt) };
      buckets.push(bucket);
    }
    bucket.available += allocation.amount;
  }
  return buckets;
};
