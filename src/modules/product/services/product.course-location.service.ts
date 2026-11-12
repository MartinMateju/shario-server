import LocationModel from "@/modules/location/location.model.js";
import { notFound } from "@/shared/http/httpErrors.js";

/** Course products are tenant-wide; their scheduled bookings own the location. */
export const getPublicCourseLocationIds = async (
  tenantId: string,
  locationId?: string,
): Promise<string[]> => {
  const locations = await LocationModel.find({
    tenant: tenantId,
    isActive: true,
    ...(locationId ? { _id: locationId } : {}),
  })
    .distinct("_id")
    .exec();
  if (locationId && locations.length !== 1) {
    notFound({
      code: "PUBLIC_COURSE_LOCATION_NOT_FOUND",
      message: "Studio location not found.",
    });
  }
  return locations.map(String);
};
