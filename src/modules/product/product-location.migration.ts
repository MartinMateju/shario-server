import {
  PRODUCT_KIND,
  normalizeProductKindV2,
  resolveLegacyProductTypeV2,
} from "./product-kind-v2.contract.js";

export type ProductLocationMigrationDocument = {
  _id: unknown;
  tenant: unknown;
  name?: unknown;
  kind?: unknown;
  type?: unknown;
  location?: unknown;
};

export type MigrationLocation = {
  _id: unknown;
  tenant: unknown;
  isActive?: boolean;
};

export type ProductLocationMigrationPlan =
  | { action: "skip" }
  | { action: "already-assigned"; locationId: string }
  | { action: "assign"; locationId: string; reason: string }
  | { action: "manual-review"; reason: string };

const id = (value: unknown): string => String(value ?? "");
const validId = (value: unknown): boolean => /^[a-f\d]{24}$/i.test(id(value));
const studioKinds: readonly string[] = [PRODUCT_KIND.OPEN_STUDIO, PRODUCT_KIND.PRIVATE_STUDIO];

/** Only plans an additive Product.location write. Historical commerce records are never rewritten. */
export const planProductLocationMigration = ({
  product,
  locations,
  historicalLocationIds,
  explicitLocationId,
}: {
  product: ProductLocationMigrationDocument;
  locations: readonly MigrationLocation[];
  historicalLocationIds: readonly unknown[];
  explicitLocationId?: string;
}): ProductLocationMigrationPlan => {
  const legacy = resolveLegacyProductTypeV2(product.type);
  const canonical = normalizeProductKindV2(product.kind);
  const kind = canonical ?? (legacy.status === "mapped" ? legacy.kind : null);
  if (!kind || !studioKinds.includes(kind)) return { action: "skip" };

  if (
    (product.kind && !canonical) ||
    (canonical && legacy.status === "mapped" && canonical !== legacy.kind)
  ) {
    return { action: "manual-review", reason: "Conflicting product kinds must be resolved first." };
  }
  if (!validId(product._id) || !validId(product.tenant)) {
    return { action: "manual-review", reason: "Invalid product or tenant identifier." };
  }
  const tenantLocations = locations.filter((location) => id(location.tenant) === id(product.tenant));
  const activeLocations = tenantLocations.filter((location) => location.isActive === true);
  const findLocation = (locationId: string) => tenantLocations.find((location) => id(location._id) === locationId);

  if (product.location != null && id(product.location) !== "") {
    const existing = id(product.location);
    if (!validId(existing) || !findLocation(existing)) {
      return { action: "manual-review", reason: "Existing location does not belong to this tenant." };
    }
    if (explicitLocationId && explicitLocationId !== existing) {
      return { action: "manual-review", reason: "An assigned product cannot be moved to another location." };
    }
    return { action: "already-assigned", locationId: existing };
  }

  if (explicitLocationId) {
    if (!validId(explicitLocationId) || findLocation(explicitLocationId)?.isActive !== true) {
      return { action: "manual-review", reason: "Explicit location must be active and belong to this tenant." };
    }
    return { action: "assign", locationId: explicitLocationId, reason: "Explicit operator assignment." };
  }

  const historical = [...new Set(historicalLocationIds.map(id))];
  if (historical.some((locationId) => !validId(locationId) || !findLocation(locationId))) {
    return { action: "manual-review", reason: "Historical usage references a missing or foreign location." };
  }
  if (historical.length > 1) {
    return { action: "manual-review", reason: "Product was used at multiple locations; explicitly choose its future location and duplicate as needed." };
  }
  if (historical.length === 1) {
    if (findLocation(historical[0])?.isActive !== true) {
      return { action: "manual-review", reason: "Historical location is inactive." };
    }
    return { action: "assign", locationId: historical[0], reason: "Only one location found in historical bookings and order lines." };
  }
  if (activeLocations.length === 1) {
    return { action: "assign", locationId: id(activeLocations[0]._id), reason: "Tenant has one active location and no conflicting historical usage." };
  }
  return { action: "manual-review", reason: "No unambiguous location; an explicit assignment is required." };
};

/** Compare-and-set guard: a concurrent assignment or catalog edit must not be overwritten. */
export const productLocationMigrationFilter = (product: ProductLocationMigrationDocument) => ({
  _id: product._id,
  tenant: product.tenant,
  kind: product.kind ?? null,
  type: product.type ?? null,
  location: product.location ?? null,
});
