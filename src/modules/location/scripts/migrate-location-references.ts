import "dotenv/config";

import mongoose, { type Types } from "mongoose";

import { logger } from "@/config/logger.js";
import connectDB from "@/infrastructure/database/connect-db.js";
import { AccessCode } from "@/modules/access-codes/access-code.model.js";
import Booking from "@/modules/booking/booking.model.js";
import { LocationModel } from "@/modules/location/location.model.js";
import {
  buildLocationCode,
  normalizeLocationCode,
  slugifyLocation,
} from "@/modules/location/location.utils.js";
import { EmailNotification } from "@/modules/notification/notification.model.js";
import { TenantModel } from "@/modules/tenants/tenant.model.js";

type LegacyReference = {
  tenantId: Types.ObjectId;
  value: string;
};

type MigrationSummary = {
  legacyReferences: number;
  locationsCreated: number;
  bookingsUpdated: number;
  accessCodesUpdated: number;
  notificationSnapshotsRemoved: number;
  dryRun: boolean;
};

const APPLY = process.env.MIGRATE_LOCATION_REFERENCES_APPLY === "true";

const humanize = (value: string): string =>
  value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) || "Studio";

const collectLegacyReferences = async (): Promise<LegacyReference[]> => {
  const pipeline = [
    { $match: { location: { $type: "string" } } },
    {
      $group: {
        _id: { tenant: "$tenant", value: "$location" },
      },
    },
  ];

  const [bookings, accessCodes] = await Promise.all([
    Booking.collection.aggregate(pipeline).toArray(),
    AccessCode.collection.aggregate(pipeline).toArray(),
  ]);
  const references = new Map<string, LegacyReference>();

  for (const item of [...bookings, ...accessCodes]) {
    const tenantId = item?._id?.tenant;
    const value = String(item?._id?.value || "").trim();

    if (!tenantId || !value) continue;

    references.set(`${String(tenantId)}:${value}`, { tenantId, value });
  }

  return [...references.values()];
};

const getAvailableIdentity = async (
  tenantId: Types.ObjectId,
  value: string,
): Promise<{ slug: string; code: string }> => {
  const baseSlug = slugifyLocation(value) || "studio";
  const baseCode = buildLocationCode(baseSlug);

  for (let index = 1; index <= 1_000; index += 1) {
    const slug = index === 1 ? baseSlug : `${baseSlug}-${index}`;
    const code =
      index === 1 ? baseCode : normalizeLocationCode(`${baseCode}-${index}`);
    const exists = await LocationModel.exists({
      tenant: tenantId,
      $or: [{ slug }, { code }],
    });

    if (!exists) return { slug, code };
  }

  throw new Error(`Could not allocate a location identity for ${value}.`);
};

const resolveLocation = async ({
  tenantId,
  value,
  referenceCountForTenant,
  summary,
}: LegacyReference & {
  referenceCountForTenant: number;
  summary: MigrationSummary;
}): Promise<Types.ObjectId | null> => {
  const slug = slugifyLocation(value);
  const existing = await LocationModel.findOne({
    tenant: tenantId,
    $or: [
      { slug },
      { code: normalizeLocationCode(value) },
      {
        name: {
          $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i",
        },
      },
    ],
  })
    .select("_id")
    .lean()
    .exec();

  if (existing?._id) return existing._id;

  const tenantLocations = await LocationModel.find({ tenant: tenantId })
    .sort({ isPrimary: -1, createdAt: 1 })
    .select("_id")
    .lean()
    .exec();

  if (referenceCountForTenant === 1 && tenantLocations.length === 1) {
    return tenantLocations[0]._id;
  }

  if (!APPLY) return null;

  const tenant = await TenantModel.findById(tenantId).lean().exec();

  if (!tenant) {
    throw new Error(`Tenant ${String(tenantId)} was not found.`);
  }

  const identity = await getAvailableIdentity(tenantId, value);
  const hasPrimary = await LocationModel.exists({
    tenant: tenantId,
    isPrimary: true,
  });
  const location = await LocationModel.create({
    tenant: tenantId,
    name: humanize(value),
    ...identity,
    isActive: true,
    isPrimary: !hasPrimary,
    booking: {
      enabled: true,
      timezone: tenant.settings?.timezone || "UTC",
    },
  });

  summary.locationsCreated += 1;
  return location._id;
};

const migrate = async (): Promise<MigrationSummary> => {
  const references = await collectLegacyReferences();
  const summary: MigrationSummary = {
    legacyReferences: references.length,
    locationsCreated: 0,
    bookingsUpdated: 0,
    accessCodesUpdated: 0,
    notificationSnapshotsRemoved: 0,
    dryRun: !APPLY,
  };
  const countsByTenant = new Map<string, number>();

  for (const reference of references) {
    const key = String(reference.tenantId);
    countsByTenant.set(key, (countsByTenant.get(key) || 0) + 1);
  }

  for (const reference of references) {
    const locationId = await resolveLocation({
      ...reference,
      referenceCountForTenant:
        countsByTenant.get(String(reference.tenantId)) || 0,
      summary,
    });

    if (!APPLY || !locationId) {
      logger.info(
        { tenantId: reference.tenantId, legacyValue: reference.value },
        "Would migrate legacy location reference.",
      );
      continue;
    }

    const [bookingResult, accessCodeResult] = await Promise.all([
      Booking.collection.updateMany(
        { tenant: reference.tenantId, location: reference.value },
        { $set: { location: locationId } },
      ),
      AccessCode.collection.updateMany(
        { tenant: reference.tenantId, location: reference.value },
        { $set: { location: locationId } },
      ),
    ]);

    summary.bookingsUpdated += bookingResult.modifiedCount;
    summary.accessCodesUpdated += accessCodeResult.modifiedCount;
  }

  if (APPLY) {
    const notificationResult = await EmailNotification.collection.updateMany(
      { "recipients.location": { $exists: true } },
      { $unset: { "recipients.$[].location": "" } },
    );
    summary.notificationSnapshotsRemoved = notificationResult.modifiedCount;

    const [remainingBookings, remainingAccessCodes] = await Promise.all([
      Booking.collection.countDocuments({ location: { $type: "string" } }),
      AccessCode.collection.countDocuments({ location: { $type: "string" } }),
    ]);

    if (remainingBookings || remainingAccessCodes) {
      throw new Error(
        `Migration incomplete: ${remainingBookings} booking and ${remainingAccessCodes} access-code string references remain.`,
      );
    }
  }

  return summary;
};

const run = async (): Promise<void> => {
  try {
    await connectDB();
    const summary = await migrate();
    logger.info(summary, "Location reference migration completed.");

    if (!APPLY && summary.legacyReferences > 0) {
      logger.warn(
        "Dry run only. Set MIGRATE_LOCATION_REFERENCES_APPLY=true to apply.",
      );
    }
  } catch (error) {
    logger.fatal({ err: error }, "Location reference migration failed.");
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  }
};

void run();
