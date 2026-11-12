import LocationModel from "@/modules/location/location.model.js";
import { buildOrderReadLocationFilter } from "@/modules/order/order.access.js";
import {
  canAccessWorkspaceLocation,
  getAllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/index.js";
import { notFound } from "@/shared/http/httpErrors.js";

import type {
  ReportContext,
  ReportLocationScope,
} from "./reports.types.js";

export const resolveReportLocationScope = async ({
  context,
  locationId,
}: {
  context: ReportContext;
  locationId?: string;
}): Promise<ReportLocationScope> => {
  const allowed = getAllowedWorkspaceLocationIds(context.access);

  if (locationId) {
    if (!canAccessWorkspaceLocation(context.access, locationId)) {
      notFound({
        message: "Location not found.",
        code: "REPORT_LOCATION_NOT_FOUND",
      });
    }
    const exists = await LocationModel.exists({
      _id: locationId,
      tenant: context.tenantId,
    });
    if (!exists) {
      notFound({
        message: "Location not found.",
        code: "REPORT_LOCATION_NOT_FOUND",
      });
    }
    return {
      requestedLocationId: locationId,
      locationIds: [locationId],
      allowedLocationIds: allowed,
      unrestricted: false,
    };
  }

  const query: Record<string, unknown> = {
    tenant: context.tenantId,
  };
  if (allowed !== null) query._id = { $in: allowed };
  const locations = await LocationModel.find(query).select("_id").lean();

  return {
    requestedLocationId: null,
    locationIds: locations.map((location) => String(location._id)),
    allowedLocationIds: allowed,
    unrestricted: allowed === null,
  };
};

export const matchesReportLocation = (
  value: unknown,
  scope: ReportLocationScope,
): boolean => {
  const id = String(value ?? "");
  return Boolean(id && scope.locationIds.includes(id));
};

export const orderLocationFilter = (
  scope: ReportLocationScope,
): Record<string, unknown> => {
  return buildOrderReadLocationFilter(
    scope.allowedLocationIds,
    scope.requestedLocationId,
  );
};
