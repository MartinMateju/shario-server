import { Types } from "mongoose";
import Location from "@/modules/location/location.model.js";
import { notFound } from "@/shared/http/httpErrors.js";
import {
  defaultDoorAccessEmailTemplate,
  doorAccessEmailTemplateSchema,
  type DoorAccessEmailTemplate,
} from "../door-access-email-template.js";

type TemplateLocation = {
  _id: Types.ObjectId;
  name: string;
  access?: { emailTemplate?: DoorAccessEmailTemplate };
};

const locationScope = (
  tenantId: string,
  allowedLocationIds?: readonly string[] | null,
) => ({
  tenant: new Types.ObjectId(tenantId),
  isActive: true,
  ...(allowedLocationIds
    ? { _id: { $in: allowedLocationIds.map((id) => new Types.ObjectId(id)) } }
    : {}),
});

const row = (location: TemplateLocation) => ({
  locationId: String(location._id),
  locationName: location.name,
  isCustomized: Boolean(location.access?.emailTemplate),
  template: location.access?.emailTemplate || defaultDoorAccessEmailTemplate(),
});

export async function listDoorAccessEmailTemplates(
  tenantId: string,
  allowedLocationIds?: readonly string[] | null,
) {
  const locations = await Location.find(
    locationScope(tenantId, allowedLocationIds),
  )
    .select("name +access.emailTemplate")
    .sort({ name: 1, _id: 1 })
    .lean<TemplateLocation[]>()
    .exec();
  return { locations: locations.map(row) };
}

export async function saveDoorAccessEmailTemplate(
  tenantId: string,
  locationId: string,
  input: unknown,
  allowedLocationIds?: readonly string[] | null,
) {
  const template = doorAccessEmailTemplateSchema.parse(input);
  return update(
    tenantId,
    locationId,
    { $set: { "access.emailTemplate": template } },
    allowedLocationIds,
  );
}

export async function resetDoorAccessEmailTemplate(
  tenantId: string,
  locationId: string,
  allowedLocationIds?: readonly string[] | null,
) {
  return update(
    tenantId,
    locationId,
    { $unset: { "access.emailTemplate": 1 } },
    allowedLocationIds,
  );
}

async function update(
  tenantId: string,
  locationId: string,
  change:
    { $set: Record<string, unknown> } | { $unset: Record<string, number> },
  allowedLocationIds?: readonly string[] | null,
) {
  if (allowedLocationIds && !allowedLocationIds.includes(locationId))
    notFound("Studio location not found.");
  const location = await Location.findOneAndUpdate(
    { ...locationScope(tenantId), _id: new Types.ObjectId(locationId) },
    change,
    { returnDocument: "after", runValidators: true },
  )
    .select("name +access.emailTemplate")
    .lean<TemplateLocation>()
    .exec();
  if (!location) notFound("Studio location not found.");
  return { location: row(location) };
}

/** Called only with the worker's tenant-checked booking location. */
export async function resolveDoorAccessEmailTemplate(
  tenantId: string,
  locationId: string,
): Promise<DoorAccessEmailTemplate | null> {
  const location = await Location.findOne({
    ...locationScope(tenantId),
    _id: new Types.ObjectId(locationId),
  })
    .select("+access.emailTemplate")
    .lean<TemplateLocation>()
    .exec();
  if (!location?.access?.emailTemplate) return null;
  // Invalid historical data must not suppress an otherwise eligible access
  // notification. Saving through the dedicated API always validates strictly.
  const parsed = doorAccessEmailTemplateSchema.safeParse(
    location.access.emailTemplate,
  );
  return parsed.success ? parsed.data : null;
}
