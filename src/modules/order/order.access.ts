import mongoose from "mongoose";

import type { AllowedWorkspaceLocationIds } from "@/modules/tenant-access/services/location-scope.service.js";
import { notFound } from "@/shared/http/httpErrors.js";

const normalizeIds = (values: readonly unknown[]): string[] =>
  [
    ...new Set(
      values.map((value) => String(value ?? "").trim()).filter(Boolean),
    ),
  ];

/**
 * Orders can span more than one location. A member with selected-location
 * access may read an order only when every location on that order is inside
 * their allow-list. Legacy/locationless orders are intentionally visible only
 * to members with all-location access.
 */
export const canAccessOrderLocations = (
  orderLocationIds: readonly unknown[],
  allowedLocationIds: AllowedWorkspaceLocationIds,
): boolean => {
  if (allowedLocationIds === null) {
    return true;
  }

  const orderLocations = normalizeIds(orderLocationIds);

  if (!orderLocations.length) {
    return false;
  }

  const allowed = new Set(normalizeIds(allowedLocationIds));
  return orderLocations.every((locationId) => allowed.has(locationId));
};

export const assertOrderLocationAccess = (
  orderLocationIds: readonly unknown[],
  allowedLocationIds: AllowedWorkspaceLocationIds,
): void => {
  if (!canAccessOrderLocations(orderLocationIds, allowedLocationIds)) {
    notFound({
      message: "Order not found.",
      code: "ORDER_NOT_FOUND",
    });
  }
};

/**
 * Produces a Mongo predicate with the same strict semantics as
 * `canAccessOrderLocations`. Applying the predicate in the database prevents
 * out-of-scope orders from affecting pagination totals and avoids loading a
 * resource before deciding whether it may be disclosed.
 */
export const buildOrderLocationScopeFilter = (
  allowedLocationIds: AllowedWorkspaceLocationIds,
): Record<string, unknown> => {
  if (allowedLocationIds === null) {
    return {};
  }

  const allowed = normalizeIds(allowedLocationIds)
    .filter(mongoose.isValidObjectId)
    .map((locationId) => new mongoose.Types.ObjectId(locationId));

  if (!allowed.length) {
    return { _id: { $exists: false } };
  }

  return {
    "locationIds.0": { $exists: true },
    locationIds: {
      $not: {
        $elemMatch: { $nin: allowed },
      },
    },
  };
};

/**
 * Combines the mandatory member scope with an optional, already-validated
 * location filter. The requested location is kept in a separate `$and`
 * predicate so it can never replace the stricter every-location rule.
 */
export const buildOrderReadLocationFilter = (
  allowedLocationIds: AllowedWorkspaceLocationIds,
  requestedLocationId?: unknown,
): Record<string, unknown> => {
  const scope = buildOrderLocationScopeFilter(allowedLocationIds);
  const requested = String(requestedLocationId ?? "").trim();

  if (!requested) {
    return scope;
  }

  return {
    ...scope,
    $and: [{ locationIds: requested }],
  };
};
