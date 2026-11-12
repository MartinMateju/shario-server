import { describe, expect, it, vi } from "vitest";
import { classifyVoucherIndex, maintainVoucherFoundationIndexes, VOUCHER_FOUNDATION_INDEXES } from "@/modules/coupon/voucher-indexes.js";

function fakeDatabase(seed: Record<string, any[]> = {}, duplicatesFor = "") {
  const indexes = new Map(Object.entries(seed));
  const aggregate = vi.fn((collection: string, pipeline: any[]) => ({
    toArray: async () => collection === duplicatesFor && pipeline.some(stage => stage.$match?.issuanceOperationId)
      ? [{ groups: 1, documents: 2 }] : [],
  }));
  const createIndex = vi.fn(async (collection: string, key: any, options: any) => {
    indexes.set(collection, [...(indexes.get(collection) ?? []), { key, ...options }]);
    return options.name;
  });
  const db: any = { collection: (name: string) => ({
    listIndexes: () => ({ toArray: async () => indexes.get(name) ?? [] }),
    aggregate: (pipeline: any[]) => aggregate(name, pipeline),
    createIndex: (key: any, options: any) => createIndex(name, key, options),
  }) };
  return { db, createIndex, aggregate };
}

describe("voucher index preflight", () => {
  it("performs a read-only dry run without creating collections or indexes", async () => {
    const { db, createIndex } = fakeDatabase();
    const report = await maintainVoucherFoundationIndexes(db);
    expect(report.mode).toBe("dry-run");
    expect(report.safeToApply).toBe(true);
    expect(report.indexesReady).toBe(false);
    expect(report.indexes).toHaveLength(11);
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("adds missing indexes once and leaves existing/unrelated indexes untouched on rerun", async () => {
    const { db, createIndex } = fakeDatabase({ couponorders: [{ name: "unrelated", key: { email: 1 } }] });
    const first = await maintainVoucherFoundationIndexes(db, { apply: true });
    expect(first.indexesReady).toBe(true);
    expect(first.created).toHaveLength(11);
    const second = await maintainVoucherFoundationIndexes(db, { apply: true });
    expect(second.indexesReady).toBe(true);
    expect(second.created).toHaveLength(0);
    expect(createIndex).toHaveBeenCalledTimes(11);
    expect(first.created.filter(name => name.startsWith("voucherdeliveries."))).toHaveLength(3);
    expect(first.created.filter(name => name.startsWith("bookingpaymentrefunds."))).toHaveLength(2);
    expect(first.created).toContain("vouchermanagementrefunds.voucher_refund_due");
  });

  it("detects conflicts before creating any of the other missing indexes", async () => {
    const { db, createIndex } = fakeDatabase({ couponorders: [{ name: "tenant_1_issuanceOperationId_1", key: { tenant: 1, issuanceOperationId: 1 }, unique: false }] });
    const report = await maintainVoucherFoundationIndexes(db, { apply: true });
    expect(report.safeToApply).toBe(false);
    expect(report.indexes.at(-1)?.state).toBe("conflict");
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("accepts equivalent existing indexes with a different name but rejects reordered compound keys", () => {
    const desired = VOUCHER_FOUNDATION_INDEXES[0];
    expect(classifyVoucherIndex(desired, [{ key: desired.key, name: "historical-name", unique: true }]).state).toBe("present");
    expect(classifyVoucherIndex(desired, [{ name: desired.name, key: { operationId: 1, tenant: 1 }, unique: true }]).state).toBe("conflict");
  });

  it("blocks duplicate operation ids within the partial-index population without exposing them", async () => {
    const { db, createIndex, aggregate } = fakeDatabase({}, "couponorders");
    const report = await maintainVoucherFoundationIndexes(db, { apply: true });
    expect(report.safeToApply).toBe(false);
    expect(report.indexes.at(-1)).toMatchObject({ state: "duplicates", duplicateGroups: 1, duplicateDocuments: 2 });
    expect(aggregate.mock.calls.at(-1)?.[1][0]).toEqual({ $match: { issuanceOperationId: { $type: "string" } } });
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("treats missing collections as missing indexes without creating them in plan mode", async () => {
    const createIndex = vi.fn();
    const db: any = { collection: () => ({
      listIndexes: () => ({ toArray: async () => { throw Object.assign(new Error("NamespaceNotFound"), { code: 26 }); } }),
      aggregate: () => ({ toArray: async () => [] }), createIndex,
    }) };
    const report = await maintainVoucherFoundationIndexes(db);
    expect(report.indexes.every(index => index.state === "missing")).toBe(true);
    expect(createIndex).not.toHaveBeenCalled();
  });
});
