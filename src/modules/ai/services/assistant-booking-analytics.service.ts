import { buildReportOverview } from "@/modules/reports/reports.service.js";
import { REPORT_GRANULARITY } from "@/modules/reports/reports.types.js";
import {
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
  type ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";

export type AssistantBookingTrend = {
  generatedAt: string;
  timezone: string;
  period: {
    from: string;
    to: string;
    days: number;
  };
  comparisonPeriod: {
    from: string;
    to: string;
    days: number;
  };
  locationId: string | null;
  coverage: {
    available: boolean;
    reason: string | null;
    limitations: string[];
  };
  reservations: {
    current: number | null;
    previous: number | null;
    changePercent: number | null;
  };
};

/**
 * Reuses the canonical Reports aggregate instead of inferring a trend from the
 * assistant's bounded booking lists. Report periods are equal tenant-calendar
 * windows, and the Reports scope resolver enforces tenant and actor locations.
 */
export const buildAssistantBookingTrend = async ({
  tenantId,
  userId,
  access,
  locationId,
  now,
}: {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
  locationId?: string | null;
  now?: Date;
}): Promise<AssistantBookingTrend> => {
  if (
    access.status !== "active" ||
    access.tenantId !== tenantId ||
    access.userId !== userId ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.REPORTS_VIEW) ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.BOOKINGS_VIEW)
  ) {
    return {
      generatedAt: (now || new Date()).toISOString(),
      timezone: "",
      period: { from: "", to: "", days: 30 },
      comparisonPeriod: { from: "", to: "", days: 30 },
      locationId: locationId || null,
      coverage: {
        available: false,
        reason: "permission_denied",
        limitations: [],
      },
      reservations: {
        current: null,
        previous: null,
        changePercent: null,
      },
    };
  }

  const report = await buildReportOverview({
    context: { tenantId, userId, access },
    query: {
      compare: true,
      granularity: REPORT_GRANULARITY.DAY,
      ...(locationId ? { locationId } : {}),
    },
    ...(now ? { now } : {}),
  });
  const bookingUnavailable = (report.coverage?.unavailable || []).find(
    (entry: any) => String(entry?.source || "") === "bookings",
  );
  const bookingAvailable =
    Array.isArray(report.coverage?.available) &&
    report.coverage.available.includes("bookings");
  const finiteOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const current = bookingAvailable
    ? finiteOrNull(report.summary?.bookings?.value)
    : null;
  const previous = bookingAvailable
    ? finiteOrNull(report.summary?.bookings?.previous)
    : null;
  const days = (() => {
    const start = new Date(`${report.metadata.period.from}T00:00:00.000Z`);
    const end = new Date(`${report.metadata.period.to}T00:00:00.000Z`);
    return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  })();
  const comparisonDays = report.metadata.comparisonPeriod
    ? (() => {
        const start = new Date(
          `${report.metadata.comparisonPeriod.from}T00:00:00.000Z`,
        );
        const end = new Date(
          `${report.metadata.comparisonPeriod.to}T00:00:00.000Z`,
        );
        return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
      })()
    : 0;

  return {
    generatedAt: report.metadata.generatedAt,
    timezone: report.metadata.timezone,
    period: {
      ...report.metadata.period,
      days,
    },
    comparisonPeriod: {
      ...(report.metadata.comparisonPeriod || { from: "", to: "" }),
      days: comparisonDays,
    },
    locationId: report.metadata.locationId || null,
    coverage: {
      available: bookingAvailable,
      reason: bookingUnavailable
        ? String(bookingUnavailable.reason || "unavailable")
        : bookingAvailable
          ? null
          : "unavailable",
      limitations: [
        "Counts use the canonical Reports definition of confirmed reservations.",
        "The current and comparison windows contain the same number of tenant-calendar days.",
      ],
    },
    reservations: {
      current,
      previous,
      changePercent:
        bookingAvailable &&
        current !== null &&
        previous !== null &&
        previous !== 0
          ? finiteOrNull(report.summary?.bookings?.changePercent)
          : null,
    },
  };
};
