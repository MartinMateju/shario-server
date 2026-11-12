import { Types } from "mongoose";
import Location from "@/modules/location/location.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Subscription from "@/modules/tenant-subscription/tenant-subscription.schema.js";
import { getSubscriptionAccess } from "@/modules/tenant-subscription/tenant-subscription.access.js";
import { getTenantModuleEntitlements } from "@/modules/tenants/tenant-workspace-modules.js";
import { tenantHasModule } from "@/shared/middleware/tenantFeatures.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import {
  ManagedSenderNotReadyError,
  resolveManagedSender,
} from "@/modules/registered-sender-email/services/managed-sender-resolver.service.js";
import { AccessCode, AccessCodeNotification } from "../access-code.model.js";
import {
  activeDeliveryPools,
  reusableDeliveryFilter,
} from "../access-code-delivery-policy.js";

export async function getDoorAccessAutomation(
  tenantId: string,
  allowedLocationIds?: readonly string[] | null,
) {
  const tenantObjectId = new Types.ObjectId(tenantId);
  const [tenant, subscription, locations] = await Promise.all([
    Tenant.findById(tenantId).exec(),
    Subscription.findOne({ tenant: tenantObjectId }).exec(),
    Location.find({
      tenant: tenantObjectId,
      isActive: true,
      ...(allowedLocationIds ? { _id: { $in: allowedLocationIds } } : {}),
    })
      .select(
        "name booking.timezone booking.doorCodeMinutesBefore access.automaticEmailEnabled",
      )
      .lean()
      .exec(),
  ]);
  let blockedReason: string | null = null;
  if (
    !tenant ||
    !getTenantModuleEntitlements({
      plan: tenant.plan,
      planVersion: tenant.planVersion,
    }).access_codes
  )
    blockedReason = "plan";
  else if (
    !subscription ||
    !getSubscriptionAccess({ tenantStatus: tenant.status, subscription })
      .canUseFeatures
  )
    blockedReason = "subscription";
  else if (!tenantHasModule(tenant, "access_codes")) blockedReason = "module";
  if (!blockedReason) {
    try {
      await resolveManagedSender({ tenantId });
    } catch (error) {
      if (error instanceof ManagedSenderNotReadyError) blockedReason = "sender";
      else throw error;
    }
  }
  const now = new Date();
  const rows = await Promise.all(
    locations.map(async (location) => {
      const pools = await activeDeliveryPools(tenantId, String(location._id));
      const availableCodes = await AccessCode.countDocuments({
        tenant: tenantObjectId,
        location: location._id,
        pool: { $in: pools },
        ...reusableDeliveryFilter(now, now),
      }).exec();
      return {
        id: String(location._id),
        name: location.name,
        timezone: location.booking?.timezone || "UTC",
        enabled: location.access?.automaticEmailEnabled === true,
        minutesBefore: location.booking?.doorCodeMinutesBefore ?? 15,
        availableCodes,
        blockedReason: blockedReason || (!availableCodes ? "inventory" : null),
      };
    }),
  );
  // Join the current booking to enforce location scope. Never return the secret,
  // recipient, raw provider error, or any access inventory identifiers.
  const deliveries = await AccessCodeNotification.aggregate([
    { $match: { tenant: tenantObjectId } },
    {
      $lookup: {
        from: "bookings",
        localField: "booking",
        foreignField: "_id",
        as: "bookingRecord",
      },
    },
    { $unwind: "$bookingRecord" },
    {
      $match: {
        "bookingRecord.tenant": tenantObjectId,
        "bookingRecord.location": { $in: locations.map((l) => l._id) },
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: 20 },
    {
      $project: {
        _id: 0,
        id: { $toString: "$_id" },
        locationId: { $toString: "$bookingRecord.location" },
        bookingStart: 1,
        status: 1,
        sentAt: 1,
        attempt: 1,
        providerDeliveryStatus: 1,
        providerStatusAt: 1,
      },
    },
  ]).exec();
  return {
    type: "doorAccessCode",
    minutesBefore: 15,
    locations: rows,
    deliveries,
  };
}

export async function updateDoorAccessAutomation(
  tenantId: string,
  locationId: string,
  enabled: boolean,
  allowedLocationIds?: readonly string[] | null,
) {
  const current = await getDoorAccessAutomation(tenantId, allowedLocationIds);
  const location = current.locations.find((item) => item.id === locationId);
  if (!location) notFound("Studio location not found.");
  if (enabled && location.blockedReason)
    conflict(
      "Resolve the door-access setup requirement before enabling automatic email.",
    );
  await Location.updateOne(
    { _id: locationId, tenant: tenantId, isActive: true },
    {
      $set: {
        "access.automaticEmailEnabled": enabled,
        ...(enabled ? { "booking.doorCodeMinutesBefore": 15 } : {}),
      },
    },
  ).exec();
  return getDoorAccessAutomation(tenantId, allowedLocationIds);
}
