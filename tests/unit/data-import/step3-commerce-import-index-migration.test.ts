import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMERCE_IMPORT_INDEXES,
  commerceImportDuplicateMatch,
  migrateCommerceImportIndexes,
  type CommerceImportIndexSpec,
  type CommerceImportIndexStore,
} from "@/modules/data-import/commerce-import-index.migration.js";
import { DATA_IMPORT_ENTITY } from "@/modules/data-import/data-import.constants.js";
import {
  assertCommerceImportReady,
  clearCommerceImportReadinessCache,
} from "@/modules/data-import/services/commerce-import-readiness.service.js";

const indexDescription = (spec: CommerceImportIndexSpec) => ({
  name: spec.name,
  unique: spec.unique ?? true,
  key: spec.keys,
  partialFilterExpression: spec.partialFilterExpression,
  expireAfterSeconds: spec.expireAfterSeconds,
});

const createStore = ({
  conflicts = new Set<string>(),
}: {
  conflicts?: Set<string>;
} = {}) => {
  const installed = new Map<string, ReturnType<typeof indexDescription>>();
  const store: CommerceImportIndexStore = {
    listIndexes: vi.fn(async (spec) =>
      installed.has(spec.name) ? [installed.get(spec.name)!] : [],
    ),
    countDuplicateGroups: vi.fn(async (spec) =>
      conflicts.has(spec.name) ? 1 : 0,
    ),
    createIndex: vi.fn(async (spec) => {
      installed.set(spec.name, indexDescription(spec));
    }),
  };
  return { installed, store };
};

describe("Step 3 commerce import index migration", () => {
  const originalEnabled = process.env.DATA_IMPORT_COMMERCE_ENABLED;

  afterEach(() => {
    clearCommerceImportReadinessCache();
    if (originalEnabled === undefined) {
      delete process.env.DATA_IMPORT_COMMERCE_ENABLED;
    } else {
      process.env.DATA_IMPORT_COMMERCE_ENABLED = originalEnabled;
    }
  });

  it("covers every correctness-critical Step 2 and Step 3 import identity", () => {
    expect(COMMERCE_IMPORT_INDEXES.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "tenant_1_product_importKey_1",
        "tenant_1_product_externalId_1",
        "tenant_1_product_fingerprint_1",
        "tenant_1_product_lastMutationKey_1",
        "membership_plan_import_key_unique",
        "membership_plan_import_external_id_unique",
        "membership_plan_import_fingerprint_unique",
        "membership_plan_last_mutation_unique",
        "user_membership_import_key_unique",
        "user_membership_import_external_id_unique",
        "user_membership_import_fingerprint_unique",
        "user_membership_last_mutation_unique",
        "coupon_import_external_id_unique",
        "coupon_import_key_unique",
        "coupon_import_fingerprint_unique",
        "coupon_import_last_mutation_unique",
        "credit_import_allocation_user_unique",
        "credit_import_allocation_external_id_unique",
        "credit_import_allocation_import_key_unique",
        "credit_import_allocation_fingerprint_unique",
        "credit_import_allocation_last_mutation_unique",
      ]),
    );
    expect(
      new Set(COMMERCE_IMPORT_INDEXES.map((index) => index.name)).size,
    ).toBe(COMMERCE_IMPORT_INDEXES.length);
  });

  it("keeps dry-run non-mutating and reports missing indexes", async () => {
    const { store } = createStore();

    const summary = await migrateCommerceImportIndexes({ store });

    expect(summary.mode).toBe("dry-run");
    expect(summary.ready).toBe(false);
    expect(summary.created).toEqual([]);
    expect(store.createIndex).not.toHaveBeenCalled();
    expect(store.countDuplicateGroups).toHaveBeenCalledTimes(
      COMMERCE_IMPORT_INDEXES.filter((index) => index.unique ?? true).length,
    );
  });

  it("keeps partial type filters intact during duplicate preflight", () => {
    const spec = COMMERCE_IMPORT_INDEXES.find(
      (index) => index.name === "coupon_import_external_id_unique",
    )!;

    expect(commerceImportDuplicateMatch(spec)).toEqual({
      $and: [
        { "importMetadata.externalId": { $type: "string" } },
        { tenant: { $exists: true } },
        { "importMetadata.externalId": { $exists: true } },
      ],
    });
  });

  it("preflights every key before creating named unique indexes", async () => {
    const { installed, store } = createStore();

    const summary = await migrateCommerceImportIndexes({ apply: true, store });

    expect(summary.ready).toBe(true);
    expect(summary.created).toHaveLength(COMMERCE_IMPORT_INDEXES.length);
    expect(installed.size).toBe(COMMERCE_IMPORT_INDEXES.length);
    expect(store.createIndex).toHaveBeenCalledTimes(
      COMMERCE_IMPORT_INDEXES.length,
    );
  });

  it("fails before any index write when duplicate groups exist", async () => {
    const conflictName = "coupon_import_external_id_unique";
    const { store } = createStore({ conflicts: new Set([conflictName]) });

    await expect(
      migrateCommerceImportIndexes({ apply: true, store }),
    ).rejects.toThrow(conflictName);
    expect(store.createIndex).not.toHaveBeenCalled();
  });

  it("keeps Step 3 disabled until the flag and exact indexes are ready", async () => {
    const checkIndexes = vi.fn(async () => true);
    await expect(
      assertCommerceImportReady(DATA_IMPORT_ENTITY.CREDITS, { checkIndexes }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "IMPORT_COMMERCE_NOT_ENABLED",
    });
    expect(checkIndexes).not.toHaveBeenCalled();

    process.env.DATA_IMPORT_COMMERCE_ENABLED = "true";
    await expect(
      assertCommerceImportReady(DATA_IMPORT_ENTITY.CREDITS, {
        checkIndexes: async () => false,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "IMPORT_COMMERCE_INDEXES_NOT_READY",
    });

    await expect(
      assertCommerceImportReady(DATA_IMPORT_ENTITY.CREDITS, { checkIndexes }),
    ).resolves.toBeUndefined();
    await expect(
      assertCommerceImportReady(DATA_IMPORT_ENTITY.CREDITS, {
        checkIndexes,
        now: Date.now() + 1,
      }),
    ).resolves.toBeUndefined();
    expect(checkIndexes).toHaveBeenCalledTimes(1);
  });

  it("gates Customer, Product, and Booking imports on rollback journal indexes", async () => {
    const checkIndexes = vi.fn(async () => false);

    for (const entityType of [
      DATA_IMPORT_ENTITY.CUSTOMERS,
      DATA_IMPORT_ENTITY.PRODUCTS,
      DATA_IMPORT_ENTITY.BOOKINGS,
    ]) {
      await expect(
        assertCommerceImportReady(entityType, { checkIndexes }),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "IMPORT_ROLLBACK_INDEXES_NOT_READY",
      });
    }

    expect(checkIndexes).toHaveBeenCalledTimes(3);
  });
});
