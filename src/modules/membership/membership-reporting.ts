import type { PipelineStage, Types } from "mongoose";

/** Members entitled to at least one visible studio, including shared plans. */
export const buildMembershipReportingLocationFilter = (
  locationIds: readonly (string | Types.ObjectId)[] | null,
): Record<string, unknown> => {
  if (locationIds === null) return {};
  const locations = [...locationIds];
  if (!locations.length) return { selectedLocation: { $in: [] } };
  return {
    $or: [
      { selectedLocation: { $in: locations } },
      {
        selectedLocation: null,
        "planSnapshot.locationScope.type": "all",
      },
      {
        "planSnapshot.locationScope.type": "shared_selected",
        "planSnapshot.locationScope.locationIds": { $in: locations },
      },
    ],
  };
};

const dateOrNull = (field: unknown) => ({
  $convert: { input: field, to: "date", onError: null, onNull: null },
});

/** Same current-entitlement requirements as the management subscriber card. */
export const membershipReportingDates: PipelineStage = {
  $set: {
    reportingStartedAt: dateOrNull("$startedAt"),
    reportingPeriodStart: dateOrNull({ $ifNull: ["$currentPeriodStart", "$startedAt"] }),
    reportingPeriodEnd: dateOrNull("$currentPeriodEnd"),
  },
};

export const membershipReportingUnknown = {
  $or: [
    { user: null },
    { reportingStartedAt: null },
    { reportingPeriodStart: null },
    { reportingPeriodEnd: null },
  ],
};

export const membershipReportingActive = (now: Date) => ({
  user: { $ne: null },
  reportingStartedAt: { $ne: null, $lte: now },
  reportingPeriodStart: { $ne: null, $lte: now },
  reportingPeriodEnd: { $gt: now },
});
