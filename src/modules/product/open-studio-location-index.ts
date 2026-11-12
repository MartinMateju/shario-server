import { isDeepStrictEqual } from "node:util";
import mongoose, { type mongo } from "mongoose";
import { normalizeProductKindV2, resolveLegacyProductTypeV2 } from "./product-kind-v2.contract.js";

export const OPEN_STUDIO_LOCATION_INDEX_KEY = { tenant: 1, location: 1 } as const;
export const OPEN_STUDIO_LOCATION_INDEX_NAME = "one_open_studio_per_tenant_location";
export const OPEN_STUDIO_LEGACY_TYPES = ["open-studio", "workshop", "public-workshop", "private-workshop"];

// Missing archival/kind fields are historical, live records. A canonical kind
// takes precedence over its compatibility type. Activity and booking mode do
// not affect ownership of the location's Open Studio slot.
export const OPEN_STUDIO_LOCATION_FILTER = {
  location: { $type: "objectId" },
  isArchived: { $in: [null, false] },
  $or: [
    { kind: "open-studio" },
    { kind: { $in: [null, ""] }, type: { $in: OPEN_STUDIO_LEGACY_TYPES } },
  ],
};

export const OPEN_STUDIO_LOCATION_INDEX_OPTIONS = {
  name: OPEN_STUDIO_LOCATION_INDEX_NAME,
  unique: true,
  partialFilterExpression: OPEN_STUDIO_LOCATION_FILTER,
};

type ProductCollection = Pick<mongo.Collection, "aggregate" | "createIndex" | "listIndexes">;

export type OpenStudioDuplicateGroup = {
  tenantId: string;
  locationId: string | null;
  products: Array<{ productId: string; name: string; isActive: boolean | null; kind: string | null; type: string | null }>;
};

/** Catch historical values accepted by dual-read normalization but not indexes.
 * New model writes use enum/casting validation; never silently rewrite old rows.
 */
export const reportOpenStudioLocationTaxonomyReview = async (
  products: Pick<mongo.Collection, "aggregate">,
): Promise<Array<{ productId: string; tenantId: string; locationId: string; reason: string }>> => {
  const rows = await products.aggregate([
    { $match: { location: { $ne: null }, isArchived: { $ne: true } } },
    { $project: { _id: 1, tenant: 1, location: 1, kind: 1, type: 1, isArchived: 1 } },
  ]).toArray();
  return rows.flatMap((product) => {
    const legacy = resolveLegacyProductTypeV2(product.type);
    const kind = normalizeProductKindV2(product.kind) ?? (legacy.status === "mapped" ? legacy.kind : null);
    if (kind !== "open-studio") return [];
    const exactTaxonomy = product.kind === "open-studio" ||
      ((product.kind == null || product.kind === "") && OPEN_STUDIO_LEGACY_TYPES.includes(product.type));
    const exactScope = product.location instanceof mongoose.Types.ObjectId &&
      product.tenant instanceof mongoose.Types.ObjectId;
    const exactArchive = product.isArchived == null || product.isArchived === false;
    return exactTaxonomy && exactScope && exactArchive ? [] : [{
      productId: String(product._id), tenantId: String(product.tenant), locationId: String(product.location),
      reason: "Normalize the stored kind/type, tenant/location ObjectIds and archive boolean explicitly before building the Open Studio index.",
    }];
  });
};

/** Read only: deliberately never guesses which existing offering to retain. */
export const reportOpenStudioLocationDuplicates = async (
  products: Pick<mongo.Collection, "aggregate">,
): Promise<OpenStudioDuplicateGroup[]> => {
  const groups = await products.aggregate([
    { $match: OPEN_STUDIO_LOCATION_FILTER },
    { $group: {
      _id: { tenant: "$tenant", location: { $ifNull: ["$location", null] } },
      count: { $sum: 1 },
      products: { $push: { productId: "$_id", name: "$name", isActive: "$isActive", kind: "$kind", type: "$type" } },
    } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { "_id.tenant": 1, "_id.location": 1 } },
  ]).toArray();
  return groups.map((group) => ({
    tenantId: String(group._id.tenant),
    locationId: group._id.location == null ? null : String(group._id.location),
    products: group.products.map((product: any) => ({
      productId: String(product.productId),
      name: String(product.name ?? ""),
      isActive: product.isActive ?? null,
      kind: product.kind ?? null,
      type: product.type ?? null,
    })),
  }));
};

/** MongoDB owns the invariant, including raw/import writes and concurrent requests. */
export const ensureOpenStudioLocationIndex = async (
  products: ProductCollection | undefined = mongoose.connection.db?.collection("products"),
): Promise<void> => {
  if (!products) throw new Error("MongoDB connection is unavailable.");
  const taxonomyReview = await reportOpenStudioLocationTaxonomyReview(products);
  if (taxonomyReview.length) {
    throw Object.assign(new Error(
      `Open Studio taxonomy requires review for ${taxonomyReview.length} product(s). Run npm run indexes:open-studio:plan before deployment. No products were changed.`,
    ), { code: "OPEN_STUDIO_TAXONOMY_REQUIRES_REVIEW", taxonomyReview });
  }
  const duplicates = await reportOpenStudioLocationDuplicates(products);
  if (duplicates.length) {
    throw Object.assign(new Error(
      `Open Studio duplicates require review in ${duplicates.length} tenant/location scope(s). Run npm run indexes:open-studio:plan and explicitly resolve the reported products before deployment. No products were changed.`,
    ), { code: "OPEN_STUDIO_DUPLICATES_REQUIRE_REVIEW", duplicates });
  }
  await products.createIndex(OPEN_STUDIO_LOCATION_INDEX_KEY, OPEN_STUDIO_LOCATION_INDEX_OPTIONS);
  const index = (await products.listIndexes().toArray()).find(({ name }) => name === OPEN_STUDIO_LOCATION_INDEX_NAME);
  if (!index?.unique || index.sparse || index.collation ||
    !isDeepStrictEqual(index.key, OPEN_STUDIO_LOCATION_INDEX_KEY) ||
    !isDeepStrictEqual(index.partialFilterExpression, OPEN_STUDIO_LOCATION_FILTER)) {
    throw new Error("The unique Open Studio location index is not ready.");
  }
};

export const isOpenStudioLocationDuplicateError = (error: unknown): boolean => {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== 11000) return false;
  const duplicate = error as { keyPattern?: unknown; message?: string };
  return isDeepStrictEqual(duplicate.keyPattern, OPEN_STUDIO_LOCATION_INDEX_KEY) ||
    Boolean(duplicate.message?.includes(OPEN_STUDIO_LOCATION_INDEX_NAME));
};
