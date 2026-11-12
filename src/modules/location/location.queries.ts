import mongoose from "mongoose";

import type { LocationListFilters } from "./location.types.js";

const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

export const buildLocationListQuery = (
  filters: LocationListFilters,
): Record<string, unknown> => {
  const query: Record<string, unknown> = {
    tenant: new mongoose.Types.ObjectId(filters.tenantId),
  };

  if (Array.isArray(filters.allowedLocationIds)) {
    query._id = {
      $in: filters.allowedLocationIds.map(
        (locationId) => new mongoose.Types.ObjectId(locationId),
      ),
    };
  }

  if (typeof filters.isActive === "boolean") {
    query.isActive = filters.isActive;
  }

  if (typeof filters.bookingEnabled === "boolean") {
    query["booking.enabled"] = filters.bookingEnabled;
  }

  if (filters.search) {
    const escaped = escapeRegex(filters.search);

    query.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { slug: { $regex: escaped, $options: "i" } },
      { code: { $regex: escaped, $options: "i" } },
      { "address.city": { $regex: escaped, $options: "i" } },
    ];
  }

  return query;
};
