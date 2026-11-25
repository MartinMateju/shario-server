import { describe, expect, it } from "vitest";
import {
  dashboardOverviewQuerySchema,
  dashboardReportBodySchema,
  dashboardReportIdSchema,
} from "@/modules/dashboard/dashboard.validators.js";

describe("studio dashboard report inputs", () => {
  it("accepts calendar dates including leap days", () => {
    expect(
      dashboardOverviewQuerySchema.safeParse({ date: "2024-02-29" }).success,
    ).toBe(true);
  });
  it.each(["2026-02-29", "2026-02-31", "2026-13-01", "2026-00-10", "invalid"])(
    "rejects impossible date %s instead of rolling into another reporting period",
    (date) => {
      expect(dashboardOverviewQuerySchema.safeParse({ date }).success).toBe(
        false,
      );
    },
  );
  it("rejects client-supplied report facts and tenant identities", () => {
    expect(
      dashboardReportBodySchema.safeParse({ date: "2026-11-07", revenue: 500 })
        .success,
    ).toBe(false);
    expect(
      dashboardReportBodySchema.safeParse({ tenantId: "another-tenant" })
        .success,
    ).toBe(false);
    expect(
      dashboardReportBodySchema.safeParse({ date: "2026-11-07", locale: "cs" })
        .success,
    ).toBe(true);
  });
  it("validates saved report identifiers before querying", () => {
    expect(dashboardReportIdSchema.safeParse("../other-report").success).toBe(
      false,
    );
    expect(
      dashboardReportIdSchema.safeParse("507f1f77bcf86cd799439011").success,
    ).toBe(true);
  });
});
