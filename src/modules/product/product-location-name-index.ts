import mongoose, { type mongo } from "mongoose";

export const PRODUCT_LOCATION_NAME_INDEX_KEY = {
  tenant: 1,
  location: 1,
  name: 1,
} as const;

export const PRODUCT_LOCATION_NAME_INDEX_OPTIONS = {
  unique: true,
  name: "tenant_1_location_1_name_1",
} as const;

type ProductNameIndex = {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  collation?: { locale?: string };
};

const hasKeys = (index: ProductNameIndex, fields: readonly string[]) =>
  Object.keys(index.key ?? {}).length === fields.length &&
  fields.every((field) => index.key?.[field] === 1);

const isFullIndex = (index: ProductNameIndex) =>
  !index.sparse &&
  !index.partialFilterExpression &&
  (!index.collation || index.collation.locale === "simple");

const isLegacyNameIndex = (index: ProductNameIndex) =>
  index.unique === true && hasKeys(index, ["tenant", "name"]);

const assertLocationNameIndex = (indexes: ProductNameIndex[]) => {
  const replacement = indexes.find(
    (index) => index.name === PRODUCT_LOCATION_NAME_INDEX_OPTIONS.name,
  );
  if (
    !replacement ||
    replacement.unique !== true ||
    !hasKeys(replacement, ["tenant", "location", "name"]) ||
    !isFullIndex(replacement)
  ) {
    throw new Error("The unique product location/name index is not ready.");
  }
};

/**
 * Index-only upgrade for existing databases, awaited before accepting traffic.
 * Never assigns locations or changes products, bookings, or purchase records.
 */
export const ensureProductLocationNameIndex = async (
  products: Pick<mongo.Collection, "createIndex" | "listIndexes" | "dropIndex"> | undefined =
    mongoose.connection.db?.collection("products"),
): Promise<{ removedLegacyIndexes: string[] }> => {
  if (!products) throw new Error("MongoDB connection is unavailable.");

  // Keep the existing constraint if the replacement cannot be built/verified.
  await products.createIndex(
    PRODUCT_LOCATION_NAME_INDEX_KEY,
    PRODUCT_LOCATION_NAME_INDEX_OPTIONS,
  );
  const indexes = await products.listIndexes().toArray();
  assertLocationNameIndex(indexes);
  const legacyIndexes = indexes.filter(isLegacyNameIndex);
  for (const index of legacyIndexes) {
    if (!index.name || !isFullIndex(index)) {
      throw new Error(
        `Unexpected options on legacy product-name index ${index.name ?? "(unnamed)"}; review it before removal.`,
      );
    }
  }

  const removedLegacyIndexes: string[] = [];
  for (const index of legacyIndexes) {
    try {
      await products.dropIndex(index.name!);
      removedLegacyIndexes.push(index.name!);
    } catch (error) {
      // Another starting API instance may have removed this exact index.
      if (!(error && typeof error === "object" && "code" in error && error.code === 27)) {
        throw error;
      }
    }
  }

  const finalIndexes = await products.listIndexes().toArray();
  assertLocationNameIndex(finalIndexes);
  if (finalIndexes.some(isLegacyNameIndex)) {
    throw new Error("The obsolete business-wide product-name index is still present.");
  }
  return { removedLegacyIndexes };
};
