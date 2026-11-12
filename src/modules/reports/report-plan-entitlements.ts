import { getPlanConfig, type PlanFeatureTier } from "@/modules/tenants/tenant.plan.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";

export type ReportPlanEntitlement = {
  tier: PlanFeatureTier | "legacy";
  courseOnly: boolean;
  firingActivity: boolean;
  studioOperations: boolean;
  consolidatedLocations: boolean;
};

export const buildCourseUtilizationSeries = (
  capacityByBucket: Map<string, number>,
  bookedSeatsByBucket: Map<string, number>,
): Map<string, number | null> => {
  const result = new Map<string, number | null>();
  for (const key of new Set([
    ...capacityByBucket.keys(),
    ...bookedSeatsByBucket.keys(),
  ])) {
    const capacity = capacityByBucket.get(key) ?? 0;
    const bookedSeats = bookedSeatsByBucket.get(key) ?? 0;
    result.set(
      key,
      capacity > 0
        ? Math.round((bookedSeats / capacity) * 10_000) / 100
        : null,
    );
  }
  return result;
};

/**
 * Historical plans retain the report surface they were sold. Plan V3 uses
 * its explicit reporting contract to decide which data domains may be read.
 */
export const getReportPlanEntitlement = ({
  plan,
  planVersion,
}: {
  plan: TenantPlan;
  planVersion: number;
}): ReportPlanEntitlement => {
  if (planVersion < 3) {
    return {
      tier: "legacy",
      courseOnly: false,
      firingActivity: false,
      studioOperations: true,
      consolidatedLocations: true,
    };
  }

  const capabilities = getPlanConfig(plan, planVersion).capabilities;
  const reporting = capabilities?.reporting;

  return {
    tier: reporting?.tier ?? "none",
    courseOnly: reporting?.tier === "limited",
    firingActivity: capabilities?.operations.firingTracking === true,
    studioOperations:
      reporting?.advancedFinancialAndOperationalReports === true,
    consolidatedLocations:
      reporting?.consolidatedCrossLocationReports === true,
  };
};
