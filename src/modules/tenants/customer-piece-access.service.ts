import mongoose from "mongoose";
import Location from "@/modules/location/location.model.js";
import { notFound } from "@/shared/http/httpErrors.js";
import { getTenantOrThrow } from "./services/tenant.service.js";
import {
  assertCustomerMyWorkEnabled,
  deriveCustomerTenantCapabilities,
  isCustomerMyWorkEnabled,
  type TenantForCustomerCapabilities,
} from "./tenant-customer-capabilities.js";

type TenantWithId = TenantForCustomerCapabilities & {
  _id?: unknown;
  id?: unknown;
};

export const getCustomerPieceLocations = async (tenant: TenantWithId) =>
  Location.find({ tenant: String(tenant._id || tenant.id), isActive: true })
    .select("_id pricingMode")
    .lean()
    .exec();

/** Root navigation remains available if at least one active studio allows work. */
export const getTenantCustomerCapabilities = async (tenant: TenantWithId) => {
  return { myWork: false };
};

export const getEnabledCustomerPieceLocationIds = async (tenantId: string) => {
  const tenant = await getTenantOrThrow(tenantId);
  const locations = await getCustomerPieceLocations(tenant);
  return locations
    .filter(
      (location) => deriveCustomerTenantCapabilities(tenant, location).myWork,
    )
    .map((location) => String(location._id));
};

/** Validate actual ownership/location before evaluating any submitted mode. */
export const assertCustomerPieceLocationEnabled = async (
  tenantId: string,
  locationId: string,
) => {
  if (!mongoose.isValidObjectId(locationId))
    notFound("Studio location not found.");
  const [tenant, location] = await Promise.all([
    getTenantOrThrow(tenantId),
    Location.findOne({ _id: locationId, tenant: tenantId, isActive: true })
      .select("_id pricingMode")
      .lean()
      .exec(),
  ]);
  if (!location) notFound("Studio location not found.");
  assertCustomerMyWorkEnabled(tenant, location);
  return location;
};
