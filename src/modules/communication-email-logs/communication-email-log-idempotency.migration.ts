import { CommunicationEmailLogModel } from "./communication-email-log.model.js";

type MongoIndex = {
  name?: string;
  key?: Record<string, number>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
};

const LEGACY_KEY: Record<string, number> = {
  tenant: 1,
  automation: 1,
  recipientEmail: 1,
  relatedEntityId: 1,
};

const IDEMPOTENCY_KEY: Record<string, number> = {
  tenant: 1,
  deduplicationKey: 1,
};

const sameIndexKey = (
  actual: Record<string, number> | undefined,
  expected: Record<string, number>,
): boolean => {
  if (!actual) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([field, direction], index) =>
        expectedEntries[index]?.[0] === field &&
        expectedEntries[index]?.[1] === direction,
    );
};

const hasExactIdempotencyFilter = (index: MongoIndex): boolean => {
  const filter = index.partialFilterExpression;
  if (!filter || Object.keys(filter).length !== 1) return false;
  const rule = filter.deduplicationKey;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
  const operators = rule as Record<string, unknown>;
  return Object.keys(operators).length === 2 &&
    operators.$type === "string" &&
    operators.$gt === "";
};

const readIndexes = async (): Promise<MongoIndex[]> => {
  try {
    return await CommunicationEmailLogModel.collection.indexes() as MongoIndex[];
  } catch (error) {
    const value = error as { code?: number; codeName?: string };
    if (value?.code === 26 || value?.codeName === "NamespaceNotFound") {
      return [];
    }
    throw error;
  }
};

export const migrateCommunicationEmailLogIdempotency = async (): Promise<{
  dropped: string[];
  created: boolean;
}> => {
  const collection = CommunicationEmailLogModel.collection;
  const dropped: string[] = [];
  let indexes = await readIndexes();
  let idempotencyIndex = indexes.find((index) =>
    sameIndexKey(index.key, IDEMPOTENCY_KEY),
  );
  if (
    idempotencyIndex &&
    (!idempotencyIndex.unique || !hasExactIdempotencyFilter(idempotencyIndex))
  ) {
    if (!idempotencyIndex.name) {
      throw new Error("Cannot replace unnamed communication idempotency index.");
    }
    await collection.dropIndex(idempotencyIndex.name);
    idempotencyIndex = undefined;
  }

  let created = false;
  if (!idempotencyIndex) {
    await collection.createIndex(IDEMPOTENCY_KEY, {
      name: "uniq_communication_delivery_per_tenant",
      unique: true,
      partialFilterExpression: {
        deduplicationKey: { $type: "string", $gt: "" },
      },
    });
    created = true;
  }

  indexes = await readIndexes();
  const verifiedIndex = indexes.find(
    (index) =>
      sameIndexKey(index.key, IDEMPOTENCY_KEY) &&
      index.unique === true &&
      hasExactIdempotencyFilter(index),
  );
  if (!verifiedIndex) {
    throw new Error(
      "Communication email idempotency index could not be verified; legacy index was retained.",
    );
  }

  for (const index of indexes) {
    if (
      index.name &&
      index.unique === true &&
      sameIndexKey(index.key, LEGACY_KEY)
    ) {
      await collection.dropIndex(index.name);
      dropped.push(index.name);
    }
  }

  return { dropped, created };
};
