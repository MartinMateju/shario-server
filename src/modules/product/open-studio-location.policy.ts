import mongoose from "mongoose";
import { conflict } from "@/shared/http/httpErrors.js";
import type { ProductRepository } from "./product.repository.js";
import { OPEN_STUDIO_LOCATION_FILTER } from "./open-studio-location-index.js";
import { resolveProductKindV2 } from "./product.utils.js";
import { getStudioProductLocationId } from "./product-location.policy.js";

export const OPEN_STUDIO_ALREADY_EXISTS_MESSAGE =
  "This location already has an Open Studio product. Edit the existing product instead.";

export const assertOpenStudioLocationAvailable = async ({ repository, input, existing, forceConflict = false }: {
  repository: ProductRepository;
  input: { kind?: unknown; type?: unknown; locationId?: unknown; location?: unknown };
  existing?: { _id?: unknown; location?: unknown; locationId?: unknown };
  forceConflict?: boolean;
}): Promise<void> => {
  if (!forceConflict && resolveProductKindV2(input) !== "open-studio") return;
  const locationId = getStudioProductLocationId(input) ?? (existing ? getStudioProductLocationId(existing) : null);
  // Unassigned historical/imported products remain reviewable until assigned.
  if (!locationId && !forceConflict) return;
  const product = await repository.findOne({
    ...OPEN_STUDIO_LOCATION_FILTER,
    location: locationId ? new mongoose.Types.ObjectId(locationId) : null,
    ...(existing?._id ? { _id: { $ne: existing._id } } : {}),
  }, { select: "_id" });
  if (product || forceConflict) {
    conflict({
      code: "OPEN_STUDIO_ALREADY_EXISTS",
      message: OPEN_STUDIO_ALREADY_EXISTS_MESSAGE,
      details: { existingProductId: product ? String(product._id) : null, locationId },
    });
  }
};
