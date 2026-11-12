import type { mongo } from "mongoose";
type Db = mongo.Db;
type Document = mongo.Document;

export type VoucherIndexSpec = {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  partialFilterExpression?: Document;
};

// Match Mongoose's default collection/index names. This inventory intentionally
// excludes unrelated legacy indexes so maintenance never replaces or drops them.
export const VOUCHER_FOUNDATION_INDEXES: readonly VoucherIndexSpec[] = [
  { collection: "voucherledgers", name: "tenant_1_operationId_1", key: { tenant: 1, operationId: 1 }, unique: true },
  { collection: "voucherledgers", name: "tenant_1_coupon_1_createdAt_1", key: { tenant: 1, coupon: 1, createdAt: 1 } },
  { collection: "voucherreservations", name: "tenant_1_operationId_1", key: { tenant: 1, operationId: 1 }, unique: true },
  { collection: "voucherreservations", name: "tenant_1_coupon_1_status_1", key: { tenant: 1, coupon: 1, status: 1 } },
  // createIndex also creates the outbox collection before its first issuance
  // transaction. Idempotency itself relies on the deterministic primary key.
  { collection: "voucherdeliveries", name: "voucher_delivery_due", key: { status: 1, nextAttemptAt: 1, createdAt: 1 } },
  { collection: "voucherdeliveries", name: "voucher_delivery_claims", key: { status: 1, claimExpiresAt: 1 } },
  { collection: "voucherdeliveries", name: "voucher_delivery_order", key: { tenant: 1, couponOrder: 1, channel: 1, generation: -1 } },
  { collection: "vouchermanagementrefunds", name: "voucher_refund_due", key: { status: 1, nextAttemptAt: 1, claimExpiresAt: 1 } },
  { collection: "bookingpaymentrefunds", name: "booking_payment_refund_due", key: { status: 1, nextAttemptAt: 1, createdAt: 1 } },
  { collection: "bookingpaymentrefunds", name: "booking_payment_refund_order", key: { tenant: 1, order: 1, booking: 1 } },
  { collection: "couponorders", name: "tenant_1_issuanceOperationId_1", key: { tenant: 1, issuanceOperationId: 1 }, unique: true,
    partialFilterExpression: { issuanceOperationId: { $type: "string" } } },
];

type ExistingIndex = Document & { name?: string; key?: Document };
export type VoucherIndexPlanItem = VoucherIndexSpec & {
  state: "present" | "missing" | "conflict" | "duplicates";
  existingName?: string;
  message?: string;
  duplicateGroups?: number;
  duplicateDocuments?: number;
};

// Field order matters for compound index keys, but not filter/option objects.
const sameKeys = (a: Document, b: Document) => JSON.stringify(Object.entries(a ?? {})) === JSON.stringify(Object.entries(b ?? {}));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
);
const sameDefinition = (existing: ExistingIndex, desired: VoucherIndexSpec) =>
  sameKeys(existing.key, desired.key) && Boolean(existing.unique) === Boolean(desired.unique) &&
  !existing.sparse && existing.expireAfterSeconds === undefined && !existing.hidden &&
  canonical(existing.partialFilterExpression ?? null) === canonical(desired.partialFilterExpression ?? null) &&
  (!existing.collation || existing.collation.locale === "simple");

export const classifyVoucherIndex = (desired: VoucherIndexSpec, existing: ExistingIndex[]): VoucherIndexPlanItem => {
  const named = existing.find(index => index.name === desired.name);
  if (named) return sameDefinition(named, desired)
    ? { ...desired, state: "present", existingName: named.name }
    : { ...desired, state: "conflict", existingName: named.name,
      message: "An index with this name has different keys or options. Inspect it and reconcile explicitly; this script never drops indexes." };
  const matchingKeys = existing.filter(index => sameKeys(index.key, desired.key));
  const equivalent = matchingKeys.find(index => sameDefinition(index, desired));
  if (equivalent) return { ...desired, state: "present", existingName: equivalent.name };
  if (matchingKeys.length) return { ...desired, state: "conflict", existingName: matchingKeys[0].name,
    message: "An index already covers these keys with different options. Reconcile its uniqueness/filter/collation before applying this migration." };
  return { ...desired, state: "missing" };
};

const listIndexes = async (db: Db, collection: string): Promise<ExistingIndex[]> => {
  try { return await db.collection(collection).listIndexes().toArray(); }
  catch (error) {
    if ((error as { code?: number }).code === 26) return [];
    throw error;
  }
};

export async function planVoucherFoundationIndexes(db: Db): Promise<VoucherIndexPlanItem[]> {
  const result: VoucherIndexPlanItem[] = [];
  for (const spec of VOUCHER_FOUNDATION_INDEXES) {
    const item = classifyVoucherIndex(spec, await listIndexes(db, spec.collection));
    if (item.state === "missing" && spec.unique) {
      const duplicates = await db.collection(spec.collection).aggregate([
        ...(spec.partialFilterExpression ? [{ $match: spec.partialFilterExpression }] : []),
        { $group: { _id: Object.fromEntries(Object.keys(spec.key).map(key => [key, `$${key}`])), count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $group: { _id: null, groups: { $sum: 1 }, documents: { $sum: "$count" } } },
      ], { maxTimeMS: 30_000 }).toArray();
      if (duplicates[0]?.groups > 0) {
        item.state = "duplicates";
        item.duplicateGroups = duplicates[0].groups;
        item.duplicateDocuments = duplicates[0].documents;
        item.message = "Duplicate operation identities must be reconciled before creating this unique index. No records were changed; customer details and operation ids are omitted from this report.";
      }
    }
    result.push(item);
  }
  return result;
}

export async function maintainVoucherFoundationIndexes(db: Db, { apply = false }: { apply?: boolean } = {}) {
  const before = await planVoucherFoundationIndexes(db);
  const safeToApply = before.every(item => item.state === "present" || item.state === "missing");
  const created: string[] = [];
  if (apply && safeToApply) {
    // Inspect all collections before making any change. createIndex itself is
    // additive and idempotent; concurrent data/index changes fail safely.
    for (const item of before.filter(item => item.state === "missing")) {
      await db.collection(item.collection).createIndex(item.key, {
        name: item.name,
        ...(item.unique ? { unique: true } : {}),
        ...(item.partialFilterExpression ? { partialFilterExpression: item.partialFilterExpression } : {}),
      });
      created.push(`${item.collection}.${item.name}`);
    }
  }
  const indexes = apply && safeToApply ? await planVoucherFoundationIndexes(db) : before;
  return {
    migration: "voucher-foundation-indexes-v1", mode: apply ? "apply" : "dry-run",
    safeToApply, indexesReady: indexes.every(item => item.state === "present"), created, indexes,
  };
}
