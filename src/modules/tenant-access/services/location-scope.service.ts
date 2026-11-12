import mongoose from "mongoose";

import LocationModel from "@/modules/location/location.model.js";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";

const normalizeLocationIds = (locationIds: readonly unknown[]): string[] =>
  [...new Set(locationIds.map((value) => String(value ?? "").trim()).filter(Boolean))];

/**
 * A `null` scope means every tenant location is available. An array is an
 * explicit allow-list and may intentionally be empty.
 */
export type AllowedWorkspaceLocationIds = readonly string[] | null;

export const assertLocationIdsWithinWorkspaceScope = (
  locationIds: readonly unknown[],
  allowedLocationIds: AllowedWorkspaceLocationIds,
): string[] => {
  const normalizedLocationIds = normalizeLocationIds(locationIds);

  if (allowedLocationIds === null) {
    return normalizedLocationIds;
  }

  const allowed = new Set(allowedLocationIds.map(String));

  if (normalizedLocationIds.some((locationId) => !allowed.has(locationId))) {
    notFound({
      message: "Location not found.",
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  }

  return normalizedLocationIds;
};

export const assertAnyLocationWithinWorkspaceScope = (
  locationIds: readonly unknown[],
  allowedLocationIds: AllowedWorkspaceLocationIds,
): string[] => {
  const normalizedLocationIds = normalizeLocationIds(locationIds);

  if (allowedLocationIds === null) {
    return normalizedLocationIds;
  }

  const allowed = new Set(allowedLocationIds.map(String));

  if (!normalizedLocationIds.some((locationId) => allowed.has(locationId))) {
    notFound({
      message: "Location not found.",
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  }

  return normalizedLocationIds;
};

export const assertCanAccessAllWorkspaceLocations = (
  allowedLocationIds: AllowedWorkspaceLocationIds,
): void => {
  if (allowedLocationIds !== null) {
    notFound({
      message: "Location not found.",
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  }
};

export const assertTenantLocationIdsExist = async (
  tenantId: string,
  locationIds: readonly unknown[],
): Promise<string[]> => {
  const normalizedLocationIds = normalizeLocationIds(locationIds);

  if (
    normalizedLocationIds.some(
      (locationId) => !mongoose.isValidObjectId(locationId),
    )
  ) {
    badRequest("One or more selected locations are invalid.");
  }

  if (!normalizedLocationIds.length) {
    return normalizedLocationIds;
  }

  const foundLocationIds = await LocationModel.find({
    _id: { $in: normalizedLocationIds },
    tenant: tenantId,
  })
    .distinct("_id")
    .exec();

  if (foundLocationIds.length !== normalizedLocationIds.length) {
    badRequest("One or more selected locations do not belong to this workspace.");
  }

  return normalizedLocationIds;
};

export const assertTenantLocationsWithinWorkspaceScope = async ({
  tenantId,
  locationIds,
  allowedLocationIds,
}: {
  tenantId: string;
  locationIds: readonly unknown[];
  allowedLocationIds: AllowedWorkspaceLocationIds;
}): Promise<string[]> => {
  const normalizedLocationIds = assertLocationIdsWithinWorkspaceScope(
    locationIds,
    allowedLocationIds,
  );

  return assertTenantLocationIdsExist(tenantId, normalizedLocationIds);
};

export const getEffectiveLocationFilter = (
  requestedLocationId: unknown,
  allowedLocationIds: AllowedWorkspaceLocationIds,
): readonly string[] | null => {
  const requested = String(requestedLocationId ?? "").trim();

  if (allowedLocationIds === null) {
    return requested ? [requested] : null;
  }

  if (!requested) {
    return allowedLocationIds;
  }

  return allowedLocationIds.includes(requested) ? [requested] : [];
};
