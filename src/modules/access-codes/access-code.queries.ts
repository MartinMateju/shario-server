import type { Types } from "mongoose";

import type { ListAccessCodesDto } from "./access-code.validators.js";
import { toObjectId } from "./access-code.utils.js";

type AccessCodeListQuery = {
  tenant: Types.ObjectId;
  location?: Types.ObjectId | { $in: Types.ObjectId[] };
  isUsed?: boolean;
  canBeRepeated?: boolean;
};

export const buildAccessCodeListQuery = (
  tenantId: string,
  filters: ListAccessCodesDto,
  allowedLocationIds: readonly string[] | null = null,
): AccessCodeListQuery => {
  const query: AccessCodeListQuery = {
    tenant: toObjectId(tenantId),
  };

  if (filters.locationId) {
    query.location = toObjectId(filters.locationId);
  } else if (allowedLocationIds !== null) {
    query.location = {
      $in: allowedLocationIds.map((locationId) => toObjectId(locationId)),
    };
  }

  if (typeof filters.isUsed === "boolean") {
    query.isUsed = filters.isUsed;
  }

  if (typeof filters.canBeRepeated === "boolean") {
    query.canBeRepeated = filters.canBeRepeated;
  }

  return query;
};
