import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildCourseUtilizationSeries,
  getReportPlanEntitlement,
} from "@/modules/reports/report-plan-entitlements.js";
import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";

describe("Plan V3 report entitlements", () => {
  it("keeps Starter reports limited to course-business data", () => {
    expect(
      getReportPlanEntitlement({ plan: TENANT_PLAN.STARTER, planVersion: 3 }),
    ).toEqual({
      tier: "limited",
      courseOnly: true,
      firingActivity: false,
      studioOperations: false,
      consolidatedLocations: false,
    });
  });

  it("enables studio operations at Professional and consolidation at Plus", () => {
    expect(
      getReportPlanEntitlement({
        plan: TENANT_PLAN.PROFESSIONAL,
        planVersion: 3,
      }),
    ).toMatchObject({
      tier: "full",
      courseOnly: false,
      firingActivity: false,
      studioOperations: true,
      consolidatedLocations: false,
    });
    expect(
      getReportPlanEntitlement({
        plan: TENANT_PLAN.STUDIO_PLUS,
        planVersion: 3,
      }),
    ).toMatchObject({
      tier: "advanced",
      courseOnly: false,
      firingActivity: false,
      studioOperations: true,
      consolidatedLocations: true,
    });
  });

  it("preserves the historical report surface", () => {
    expect(
      getReportPlanEntitlement({
        plan: TENANT_PLAN.STARTER,
        planVersion: 2,
      }),
    ).toEqual({
      tier: "legacy",
      courseOnly: false,
      firingActivity: false,
      studioOperations: true,
      consolidatedLocations: true,
    });
  });

  it("uses seat capacity rather than participant-hours for course occupancy", () => {
    expect(
      buildCourseUtilizationSeries(
        new Map([["2026-08-01", 10]]),
        new Map([["2026-08-01", 10]]),
      ).get("2026-08-01"),
    ).toBe(100);
    expect(
      buildCourseUtilizationSeries(
        new Map([["2026-08-01", 0]]),
        new Map([["2026-08-01", 4]]),
      ).get("2026-08-01"),
    ).toBeNull();
  });

  it("is consumed by report data loading and response metadata", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../../src/modules/reports/reports.service.ts", import.meta.url),
      ),
      "utf8",
    );

    expect(source).toContain("getReportPlanEntitlement");
    expect(source).toContain("reportEntitlement.studioOperations");
    expect(source).not.toContain("buildFirings");
    expect(source).toContain("courseOnly: reportEntitlement.courseOnly");
    expect(source).toContain(
      "historical non-course orders are intentionally excluded",
    );
    expect(source).toContain("reportEntitlement.consolidatedLocations");
    expect(source).toContain("reportingTier: reportEntitlement.tier");
  });
});
