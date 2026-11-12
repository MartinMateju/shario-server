import mongoose from "mongoose";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";
import { PRODUCT_KIND, PRODUCT_KINDS } from "./product-kind-v2.contract.js";
import { resolveProductKindV2 } from "./product.utils.js";

type LocationProduct = { kind?: unknown; type?: unknown; location?: unknown; locationId?: unknown; isArchived?: boolean };

export const isStudioProduct = (product: LocationProduct): boolean => {
  const kind = resolveProductKindV2(product);
  return kind === PRODUCT_KIND.OPEN_STUDIO || kind === PRODUCT_KIND.PRIVATE_STUDIO;
};

export const getStudioProductLocationId = (product: LocationProduct): string | null => {
  const location = product.location ?? product.locationId;
  if (!location) return null;
  return String(typeof location === "object" && "_id" in location ? location._id : location);
};

/** Only use for new selections. Historical reservations keep their stored location. */
export const assertStudioProductLocation = (product: LocationProduct, locationId: unknown): void => {
  if (!isStudioProduct(product)) return;
  if (product.isArchived) badRequest({ code: "PRODUCT_ARCHIVED", message: "This studio product is archived and cannot be used for new bookings." });
  const assigned = getStudioProductLocationId(product);
  if (!assigned) badRequest({ code: "PRODUCT_LOCATION_REQUIRED", message: "Assign this studio product to a location before using it for a new booking." });
  if (assigned !== String(locationId ?? "")) badRequest({ code: "PRODUCT_LOCATION_MISMATCH", message: "This studio product is not offered at the selected location." });
};

export const assertStudioProductLocationAccess = (product: LocationProduct, allowedLocationIds: readonly string[] | null): void => {
  if (!isStudioProduct(product) || allowedLocationIds === null) return;
  const locationId = getStudioProductLocationId(product);
  if (!locationId || !allowedLocationIds.includes(locationId)) notFound("Product not found.");
};

/** Match the dual-read taxonomy, giving valid canonical kinds precedence. */
export const studioProductFilter = {
  $or: [
    { kind: { $in: [PRODUCT_KIND.OPEN_STUDIO, PRODUCT_KIND.PRIVATE_STUDIO] } },
    { kind: { $nin: PRODUCT_KINDS }, type: { $in: ["open-studio", "workshop", "public-workshop", "private-workshop", "private-studio", "blocker"] } },
  ],
};

export const buildProductLocationFilter = ({ locationId, allowedLocationIds, includeUnassigned, assignedStudioOnly }: {
  locationId?: string;
  allowedLocationIds?: readonly string[] | null;
  includeUnassigned?: boolean;
  assignedStudioOnly?: boolean;
}): Record<string, unknown> | null => {
  const restricted = Array.isArray(allowedLocationIds);
  if (!locationId && !restricted && !assignedStudioOnly) return null;
  const locationFilter = locationId
    ? { location: restricted && !allowedLocationIds.includes(locationId) ? { $in: [] } : new mongoose.Types.ObjectId(locationId) }
    : restricted
      ? { location: { $in: allowedLocationIds.map((id) => new mongoose.Types.ObjectId(id)) } }
      : { location: { $type: "objectId" } };
  const studioLocations = includeUnassigned && !restricted && !assignedStudioOnly
    ? { $or: [locationFilter, { location: null }] }
    : locationFilter;
  return { $or: [{ $nor: [studioProductFilter] }, { $and: [studioProductFilter, studioLocations] }] };
};
