import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildReportOverview: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("@/modules/reports/reports.service.js", () => ({
  buildReportOverview: mocks.buildReportOverview,
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  hasWorkspacePermission: mocks.hasPermission,
  WORKSPACE_PERMISSION: {
    REPORTS_VIEW: "reports.view",
    BOOKINGS_VIEW: "bookings.view",
  },
}));

import { buildAssistantBookingTrend } from "@/modules/ai/services/assistant-booking-analytics.service.js";
import { resolveReportPeriod } from "@/modules/reports/reports.date.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";

const access = (permissions = ["reports.view", "bookings.view"]) => ({
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: "active",
  permissions,
  locationAccess: { mode: "all", locationIds: [] },
  preferences: { language: "en" },
});
const report = ({
  current = 12,
  previous = 8,
  changePercent = 50,
  bookingAvailable = true,
}: {
  current?: number | null;
  previous?: number | null;
  changePercent?: number | null;
  bookingAvailable?: boolean;
} = {}) => ({
  metadata: {
    timezone: "Europe/Prague",
    currency: "CZK",
    period: { from: "2026-03-01", to: "2026-03-30" },
    comparisonPeriod: { from: "2026-01-30", to: "2026-02-28" },
    granularity: "day",
    generatedAt: "2026-03-30T10:00:00.000Z",
    locationId: LOCATION_ID,
    locale: "en",
  },
  coverage: {
    available: bookingAvailable ? ["bookings"] : [],
    unavailable: bookingAvailable
      ? []
      : [{ source: "bookings", reason: "permission_denied" }],
    limitations: [],
    complete: bookingAvailable,
  },
  summary: {
    bookings: {
      value: current,
      previous,
      changePercent,
    },
  },
});

describe("assistant booking trend analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasPermission.mockImplementation(
      (actor: { permissions?: string[] }, permission: string) =>
        actor.permissions?.includes(permission) ?? false,
    );
    mocks.buildReportOverview.mockResolvedValue(report());
  });

  it("reuses the canonical equal-period report query with location scope", async () => {
    const now = new Date("2026-03-30T10:00:00.000Z");
    const result = await buildAssistantBookingTrend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access() as any,
      locationId: LOCATION_ID,
      now,
    });

    expect(mocks.buildReportOverview).toHaveBeenCalledWith({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: {
        compare: true,
        granularity: "day",
        locationId: LOCATION_ID,
      },
      now,
    });
    expect(result).toMatchObject({
      timezone: "Europe/Prague",
      period: { from: "2026-03-01", to: "2026-03-30", days: 30 },
      comparisonPeriod: {
        from: "2026-01-30",
        to: "2026-02-28",
        days: 30,
      },
      coverage: { available: true, reason: null },
      reservations: { current: 12, previous: 8, changePercent: 50 },
    });
  });

  it.each([
    ["reports permission", ["bookings.view"]],
    ["bookings permission", ["reports.view"]],
  ])("does not query Reports when %s is missing", async (_label, permissions) => {
    const result = await buildAssistantBookingTrend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access(permissions) as any,
      locationId: LOCATION_ID,
    });
    expect(result.coverage).toMatchObject({
      available: false,
      reason: "permission_denied",
    });
    expect(result.reservations).toEqual({
      current: null,
      previous: null,
      changePercent: null,
    });
    expect(mocks.buildReportOverview).not.toHaveBeenCalled();
  });

  it("preserves verified zero counts but keeps every zero-baseline percentage null", async () => {
    mocks.buildReportOverview.mockResolvedValueOnce(
      report({ current: 0, previous: 0, changePercent: 0 }),
    );
    const bothZero = await buildAssistantBookingTrend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access() as any,
    });
    expect(bothZero.reservations).toEqual({
      current: 0,
      previous: 0,
      changePercent: null,
    });

    mocks.buildReportOverview.mockResolvedValueOnce(
      report({ current: 5, previous: 0, changePercent: null }),
    );
    const grewFromZero = await buildAssistantBookingTrend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access() as any,
    });
    expect(grewFromZero.reservations).toEqual({
      current: 5,
      previous: 0,
      changePercent: null,
    });
  });

  it("never coerces unavailable or missing KPI values into verified zero", async () => {
    mocks.buildReportOverview.mockResolvedValue(
      report({
        current: null,
        previous: null,
        changePercent: null,
        bookingAvailable: false,
      }),
    );
    const unavailable = await buildAssistantBookingTrend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access() as any,
    });
    expect(unavailable.coverage.available).toBe(false);
    expect(unavailable.reservations).toEqual({
      current: null,
      previous: null,
      changePercent: null,
    });

    mocks.buildReportOverview.mockResolvedValue(
      report({
        current: null,
        previous: null,
        changePercent: 0,
        bookingAvailable: true,
      }),
    );
    const missing = await buildAssistantBookingTrend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access() as any,
    });
    expect(missing.coverage.available).toBe(true);
    expect(missing.reservations).toEqual({
      current: null,
      previous: null,
      changePercent: null,
    });
  });

  it("uses equal tenant-calendar periods across the Prague DST transition", () => {
    const periods = resolveReportPeriod({
      query: { compare: true, granularity: "day" },
      timezone: "Europe/Prague",
      now: new Date("2026-03-30T10:00:00.000Z"),
    });
    expect(periods.current.days).toBe(30);
    expect(periods.comparison?.days).toBe(30);
    expect(periods.current.from).toBe("2026-03-01");
    expect(periods.current.to).toBe("2026-03-30");
    // The current period crosses spring DST and is therefore not 30 * 24h.
    expect(
      periods.current.endExclusive.getTime() - periods.current.start.getTime(),
    ).toBe(30 * 86_400_000 - 3_600_000);
  });
});
