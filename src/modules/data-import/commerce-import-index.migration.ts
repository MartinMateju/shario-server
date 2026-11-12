import { Coupon } from "@/modules/coupon/coupon.model.js";
import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import UserMembershipModel from "@/modules/membership/user-membership.model.js";
import CreditImportAllocationModel from "@/modules/money-credit/credit-import-allocation.model.js";
import ProductModel from "@/modules/product/product.model.js";
import DataImportMutationModel from "./data-import-mutation.model.js";

type IndexKeys = Record<string, 1 | -1>;
type CommerceImportCollection = typeof ProductModel.collection;
type IndexDescription = {
  name?: string;
  unique?: boolean;
  key?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
};

export type CommerceImportIndexSpec = {
  collection: CommerceImportCollection;
  keys: IndexKeys;
  name: string;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
};

const stringPartial = (field: string) => ({
  [field]: { $type: "string" },
});

const metadataIndex = (
  collection: CommerceImportCollection,
  field: string,
  name: string,
): CommerceImportIndexSpec => ({
  collection,
  keys: { tenant: 1, [`importMetadata.${field}`]: 1 },
  name,
  unique: true,
  partialFilterExpression: stringPartial(`importMetadata.${field}`),
});

export const COMMERCE_IMPORT_INDEXES: CommerceImportIndexSpec[] = [
  {
    collection: DataImportMutationModel.collection as CommerceImportCollection,
    keys: { tenant: 1, session: 1, row: 1, mutationKey: 1 },
    name: "tenant_session_row_mutation_unique",
    unique: true,
  },
  {
    collection: DataImportMutationModel.collection as CommerceImportCollection,
    keys: { tenant: 1, session: 1, row: 1, isCanonicalResult: 1 },
    name: "tenant_session_row_canonical_result_unique",
    unique: true,
    partialFilterExpression: { isCanonicalResult: true },
  },
  {
    collection: DataImportMutationModel.collection as CommerceImportCollection,
    keys: { tenant: 1, session: 1, "rollback.status": 1, rowNumber: -1 },
    name: "tenant_session_rollback_status_order",
    unique: false,
  },
  {
    collection: DataImportMutationModel.collection as CommerceImportCollection,
    keys: { tenant: 1, session: 1, rowNumber: -1, createdAt: -1 },
    name: "tenant_session_rollback_order",
    unique: false,
  },
  {
    collection: DataImportMutationModel.collection as CommerceImportCollection,
    keys: { expiresAt: 1 },
    name: "expiresAt_1",
    unique: false,
    expireAfterSeconds: 0,
  },
  metadataIndex(
    ProductModel.collection,
    "importKey",
    "tenant_1_product_importKey_1",
  ),
  metadataIndex(
    ProductModel.collection,
    "externalId",
    "tenant_1_product_externalId_1",
  ),
  metadataIndex(
    ProductModel.collection,
    "fingerprint",
    "tenant_1_product_fingerprint_1",
  ),
  metadataIndex(
    ProductModel.collection,
    "lastMutationKey",
    "tenant_1_product_lastMutationKey_1",
  ),
  metadataIndex(
    MembershipPlanModel.collection,
    "importKey",
    "membership_plan_import_key_unique",
  ),
  metadataIndex(
    MembershipPlanModel.collection,
    "externalId",
    "membership_plan_import_external_id_unique",
  ),
  metadataIndex(
    MembershipPlanModel.collection,
    "fingerprint",
    "membership_plan_import_fingerprint_unique",
  ),
  metadataIndex(
    MembershipPlanModel.collection,
    "lastMutationKey",
    "membership_plan_last_mutation_unique",
  ),
  metadataIndex(
    UserMembershipModel.collection,
    "importKey",
    "user_membership_import_key_unique",
  ),
  metadataIndex(
    UserMembershipModel.collection,
    "externalId",
    "user_membership_import_external_id_unique",
  ),
  metadataIndex(
    UserMembershipModel.collection,
    "fingerprint",
    "user_membership_import_fingerprint_unique",
  ),
  metadataIndex(
    UserMembershipModel.collection,
    "lastMutationKey",
    "user_membership_last_mutation_unique",
  ),
  metadataIndex(
    Coupon.collection,
    "externalId",
    "coupon_import_external_id_unique",
  ),
  metadataIndex(Coupon.collection, "importKey", "coupon_import_key_unique"),
  metadataIndex(
    Coupon.collection,
    "fingerprint",
    "coupon_import_fingerprint_unique",
  ),
  metadataIndex(
    Coupon.collection,
    "lastMutationKey",
    "coupon_import_last_mutation_unique",
  ),
  {
    collection: CreditImportAllocationModel.collection,
    keys: { tenant: 1, user: 1 },
    name: "credit_import_allocation_user_unique",
  },
  {
    collection: CreditImportAllocationModel.collection,
    keys: { tenant: 1, externalId: 1 },
    name: "credit_import_allocation_external_id_unique",
    partialFilterExpression: stringPartial("externalId"),
  },
  {
    collection: CreditImportAllocationModel.collection,
    keys: { tenant: 1, importKey: 1 },
    name: "credit_import_allocation_import_key_unique",
  },
  {
    collection: CreditImportAllocationModel.collection,
    keys: { tenant: 1, fingerprint: 1 },
    name: "credit_import_allocation_fingerprint_unique",
  },
  {
    collection: CreditImportAllocationModel.collection,
    keys: { tenant: 1, lastMutationKey: 1 },
    name: "credit_import_allocation_last_mutation_unique",
    partialFilterExpression: stringPartial("lastMutationKey"),
  },
];

export type CommerceImportIndexInspection = {
  name: string;
  collection: string;
  ready: boolean;
  conflictGroups: number;
};

export type CommerceImportIndexMigrationSummary = {
  mode: "dry-run" | "apply";
  ready: boolean;
  created: string[];
  indexes: CommerceImportIndexInspection[];
};

export type CommerceImportIndexStore = {
  listIndexes(spec: CommerceImportIndexSpec): Promise<IndexDescription[]>;
  countDuplicateGroups(spec: CommerceImportIndexSpec): Promise<number>;
  createIndex(spec: CommerceImportIndexSpec): Promise<void>;
};

const normalizedEntries = (value: unknown): Array<[string, unknown]> =>
  Object.entries((value ?? {}) as Record<string, unknown>);

const sameObject = (left: unknown, right: unknown): boolean =>
  JSON.stringify(normalizedEntries(left)) ===
  JSON.stringify(normalizedEntries(right));

const matchesSpec = (
  index: IndexDescription,
  spec: CommerceImportIndexSpec,
): boolean =>
  index.name === spec.name &&
  Boolean(index.unique) === Boolean(spec.unique ?? true) &&
  sameObject(index.key, spec.keys) &&
  sameObject(index.partialFilterExpression, spec.partialFilterExpression) &&
  (spec.expireAfterSeconds === undefined ||
    Number(index.expireAfterSeconds) === spec.expireAfterSeconds);

export const commerceImportDuplicateMatch = (
  spec: CommerceImportIndexSpec,
) => ({
  $and: [
    ...(spec.partialFilterExpression ? [spec.partialFilterExpression] : []),
    ...Object.keys(spec.keys).map((field) => ({
      [field]: { $exists: true },
    })),
  ],
});

const mongoStore: CommerceImportIndexStore = {
  async listIndexes(spec) {
    try {
      return await spec.collection.listIndexes().toArray();
    } catch (error) {
      if ((error as { code?: number })?.code === 26) return [];
      throw error;
    }
  },
  async countDuplicateGroups(spec) {
    try {
      const [result] = await spec.collection
        .aggregate<{ count: number }>(
          [
            { $match: commerceImportDuplicateMatch(spec) },
            {
              $group: {
                _id: Object.fromEntries(
                  Object.keys(spec.keys).map((field) => [
                    field.replaceAll(".", "_"),
                    `$${field}`,
                  ]),
                ),
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: 1 } } },
            { $count: "count" },
          ],
          { allowDiskUse: true },
        )
        .toArray();
      return result?.count ?? 0;
    } catch (error) {
      if ((error as { code?: number })?.code === 26) return 0;
      throw error;
    }
  },
  async createIndex(spec) {
    await spec.collection.createIndex(spec.keys, {
      name: spec.name,
      unique: spec.unique ?? true,
      ...(spec.expireAfterSeconds !== undefined
        ? { expireAfterSeconds: spec.expireAfterSeconds }
        : {}),
      ...(spec.partialFilterExpression
        ? { partialFilterExpression: spec.partialFilterExpression }
        : {}),
    });
  },
};

export const inspectCommerceImportIndexes = async ({
  includeDuplicatePreflight = false,
  store = mongoStore,
}: {
  includeDuplicatePreflight?: boolean;
  store?: CommerceImportIndexStore;
} = {}): Promise<CommerceImportIndexInspection[]> => {
  const inspections: CommerceImportIndexInspection[] = [];
  // Run preflight scans sequentially. These can be full collection scans on a
  // first rollout, and issuing all of them at once creates avoidable DB load.
  for (const spec of COMMERCE_IMPORT_INDEXES) {
    const indexes = await store.listIndexes(spec);
    const ready = indexes.some((index) => matchesSpec(index, spec));
    inspections.push({
      name: spec.name,
      collection: spec.collection.collectionName,
      ready,
      conflictGroups:
        !ready && includeDuplicatePreflight && (spec.unique ?? true)
          ? await store.countDuplicateGroups(spec)
          : 0,
    });
  }
  return inspections;
};

export const migrateCommerceImportIndexes = async ({
  apply = false,
  store = mongoStore,
}: {
  apply?: boolean;
  store?: CommerceImportIndexStore;
} = {}): Promise<CommerceImportIndexMigrationSummary> => {
  const before = await inspectCommerceImportIndexes({
    includeDuplicatePreflight: true,
    store,
  });
  const conflicts = before.filter((index) => index.conflictGroups > 0);
  if (conflicts.length) {
    throw new Error(
      `Commerce import index preflight found duplicate groups: ${conflicts
        .map(
          (index) =>
            `${index.collection}.${index.name}=${index.conflictGroups}`,
        )
        .join(", ")}`,
    );
  }

  const created: string[] = [];
  if (apply) {
    for (let index = 0; index < COMMERCE_IMPORT_INDEXES.length; index += 1) {
      if (before[index].ready) continue;
      const spec = COMMERCE_IMPORT_INDEXES[index];
      await store.createIndex(spec);
      created.push(spec.name);
    }
  }

  const indexes = apply
    ? await inspectCommerceImportIndexes({ store })
    : before;
  return {
    mode: apply ? "apply" : "dry-run",
    ready: indexes.every((index) => index.ready),
    created,
    indexes,
  };
};

export const commerceImportIndexesReady = async ({
  store = mongoStore,
}: {
  store?: CommerceImportIndexStore;
} = {}): Promise<boolean> =>
  (await inspectCommerceImportIndexes({ store })).every((index) => index.ready);
