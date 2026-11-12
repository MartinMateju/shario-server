import { Types } from "mongoose";
import { AccessCodePool } from "./access-code.model.js";

// Legacy suppression remains provenance. Only the exact occurrence authorized
// by staff may opt into managed access delivery; unrelated edits cannot replay it.
export const accessNotificationOccurrenceFilter = () => ({
  $or: [
    { "atelierKleiMigration.suppressAccessNotifications": { $ne: true } },
    {
      accessCodeStaffRescheduledStart: { $type: "date" as const },
      $expr: { $eq: ["$accessCodeStaffRescheduledStart", "$start"] },
    },
  ],
});

/** Automatic delivery only uses verified reusable inventory, never emergency codes. */
export const reusableDeliveryFilter = (now: Date, through: Date) => ({
  type: "reusable" as const,
  status: "available" as const,
  canBeRepeated: true,
  verifiedAt: { $ne: null },
  entryCode: { $regex: "^v1:" },
  $and: [
    { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
    { $or: [{ validUntil: null }, { validUntil: { $gt: through } }] },
    { $or: [{ expiresAt: null }, { expiresAt: { $gt: through } }] },
  ],
});

export const activeDeliveryPools = async (
  tenantId: string,
  locationId?: string,
) =>
  AccessCodePool.find({
    tenant: new Types.ObjectId(tenantId),
    ...(locationId ? { location: new Types.ObjectId(locationId) } : {}),
    isActive: true,
  })
    .distinct("_id")
    .exec();
