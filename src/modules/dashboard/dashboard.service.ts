import mongoose from "mongoose";
import { activeBookingParticipants } from "@/modules/booking/booking.attendance-read.js";

import Booking from "@/modules/booking/booking.model.js";
import {
  BOOKING_STATUS,
  BOOKING_TAG,
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import { reportService } from "@/modules/reports/reports.service.js";
import { resolveReportPeriod } from "@/modules/reports/reports.date.js";
import { resolveReportLocationScope } from "@/modules/reports/reports.scope.js";
import { REPORT_GRANULARITY } from "@/modules/reports/reports.types.js";
import {
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/index.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { notFound } from "@/shared/http/httpErrors.js";

import type {
  DashboardContext,
  DashboardCoverageEntry,
  DashboardQuery,
} from "./dashboard.types.js";
import {
  loadCourseCapacityAdvisor,
  type CourseCapacityAdvisorSignal,
} from "./course-capacity-advisor.service.js";
import {
  loadDashboardSignals,
  type DashboardSignals,
} from "./dashboard.signals.js";

const SCHEDULE_LIMIT = 12;

const flowHref = {
  booked: "/app/bookings",
  arriving: "/app/bookings",
  inStudio: "/app/bookings",
} as const;

const attentionHref = {
  unpaidBookings: "/app/bookings",
  lowStock: "/app/operations?section=inventory",
  overdueTasks: "/app/operations?section=tasks",
} as const;

type ScheduleSource = {
  items: Array<{
    id: string;
    title: string;
    productType: string | null;
    start: string;
    end: string;
    locationId: string;
    locationName: string;
    participantCount: number;
    capacity: number | null;
    status: string;
  }>;
  booked: number;
  unpaidBookings: number;
  expectedVisitors: number;
  inStudio: number;
};

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const nonNegativeNumber = (value: unknown): number =>
  Math.max(finiteNumber(value) ?? 0, 0);

const asIso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
};

const entityId = (value: unknown): string =>
  String(
    value && typeof value === "object" && "_id" in value
      ? (value as { _id?: unknown })._id
      : (value ?? ""),
  ).trim();

const localizedText = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value.trim() || fallback;
  if (value && typeof value === "object") {
    const localized = value as Record<string, unknown>;
    for (const key of ["CZ", "EN", "cs", "en"]) {
      const candidate = localized[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  return fallback;
};

const participantCount = (booking: any): number => {
  const participants = activeBookingParticipants(booking).length;
  const guests = nonNegativeNumber(booking?.numberOfGuests);

  if ((CLASS_BOOKING_TAGS as readonly string[]).includes(booking?.tag)) {
    return Math.max(participants, guests);
  }

  return Math.max(participants, guests, 1);
};

const bookingParticipantCountExpression = {
  $let: {
    vars: {
      participants: {
        $size: {
          $filter: {
            input: { $ifNull: ["$participants", []] },
            as: "participant",
            cond: {
              $ne: [{ $ifNull: ["$$participant.attendanceStatus", "active"] }, "removed"],
            },
          },
        },
      },
      guests: { $max: [{ $ifNull: ["$numberOfGuests", 0] }, 0] },
    },
    in: {
      $cond: [
        { $in: ["$tag", CLASS_BOOKING_TAGS] },
        { $max: ["$$participants", "$$guests"] },
        { $max: ["$$participants", "$$guests", 1] },
      ],
    },
  },
};

const moduleEnabled = (
  modules: Record<string, unknown>,
  module: string,
): boolean => modules?.[module] !== false;

const permissionAvailable = (
  context: DashboardContext,
  permission: (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION],
): boolean => hasWorkspacePermission(context.access, permission);

const availabilityReason = ({
  enabled,
  permitted,
}: {
  enabled: boolean;
  permitted: boolean;
}): string | null => {
  if (!enabled) return "module_disabled";
  if (!permitted) return "permission_required";
  return null;
};

const locationPredicate = (
  locationIds: readonly string[],
): Record<string, unknown> => ({
  location: {
    $in: locationIds.map(
      (locationId) => new mongoose.Types.ObjectId(locationId),
    ),
  },
});

const firstCustomerBookingQuery = ({
  tenantId,
  locationIds,
}: {
  tenantId: string;
  locationIds: readonly string[] | null;
}): Record<string, unknown> => ({
  tenant: tenantId,
  ...(locationIds ? locationPredicate(locationIds) : {}),
  status: { $ne: BOOKING_STATUS.CANCELLED },
  paymentStatus: PAYMENT_STATUS.CONFIRMED,
  "importMetadata.importId": { $exists: false },
  $or: [
    { tag: { $in: OPEN_STUDIO_BOOKING_TAGS } },
    {
      tag: { $in: CLASS_BOOKING_TAGS },
      $or: [
        { "orders.0": { $exists: true } },
        { "participants.0": { $exists: true } },
        { numberOfGuests: { $gt: 0 } },
      ],
    },
  ],
});

const loadFirstCustomerBookingMilestone = async ({
  tenantId,
  locationIds,
}: {
  tenantId: string;
  locationIds: readonly string[] | null;
}): Promise<boolean> =>
  Boolean(
    await Booking.exists(firstCustomerBookingQuery({ tenantId, locationIds })),
  );

const bookingBaseQuery = ({
  context,
  locationIds,
  start,
  end,
}: {
  context: DashboardContext;
  locationIds: readonly string[];
  start: Date;
  end: Date;
}): Record<string, unknown> => ({
  tenant: context.tenantId,
  ...locationPredicate(locationIds),
  start: { $gte: start, $lt: end },
  status: { $ne: BOOKING_STATUS.CANCELLED },
  paymentStatus: PAYMENT_STATUS.CONFIRMED,
  tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
});

const loadScheduleSource = async ({
  context,
  locationIds,
  period,
  now,
}: {
  context: DashboardContext;
  locationIds: readonly string[];
  period: { start: Date; endExclusive: Date };
  now: Date;
}): Promise<ScheduleSource> => {
  const confirmed = bookingBaseQuery({
    context,
    locationIds,
    start: period.start,
    end: period.endExclusive,
  });
  const aggregateLocation = locationPredicate(locationIds);
  const dailyMatch = {
    tenant: new mongoose.Types.ObjectId(context.tenantId),
    ...aggregateLocation,
    start: { $gte: period.start, $lt: period.endExclusive },
    status: { $ne: BOOKING_STATUS.CANCELLED },
    paymentStatus: {
      $in: [PAYMENT_STATUS.CONFIRMED, PAYMENT_STATUS.PENDING_PAYMENT],
    },
    tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
  };
  const activeMatch = {
    tenant: new mongoose.Types.ObjectId(context.tenantId),
    ...aggregateLocation,
    start: { $lte: now },
    end: { $gt: now },
    status: { $ne: BOOKING_STATUS.CANCELLED },
    paymentStatus: PAYMENT_STATUS.CONFIRMED,
    tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
  };

  const scheduleQuery = Booking.find(confirmed)
    .sort({ start: 1, _id: 1 })
    .limit(SCHEDULE_LIMIT)
    .select(
      "_id start end bookingProduct location participants numberOfGuests tag status",
    )
    .populate({
      path: "bookingProduct",
      select: "name type maxNumberOfParticipants",
      match: { tenant: context.tenantId },
    })
    .populate({
      path: "location",
      select: "name booking.globalCapacity",
      match: { tenant: context.tenantId },
    })
    .lean();

  const [bookings, dailyRows, liveRows] = await Promise.all([
    scheduleQuery,
    Booking.aggregate([
      { $match: dailyMatch },
      {
        $group: {
          _id: null,
          booked: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", PAYMENT_STATUS.CONFIRMED] },
                1,
                0,
              ],
            },
          },
          unpaidBookings: {
            $sum: {
              $cond: [
                {
                  $eq: ["$paymentStatus", PAYMENT_STATUS.PENDING_PAYMENT],
                },
                1,
                0,
              ],
            },
          },
          expectedVisitors: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", PAYMENT_STATUS.CONFIRMED] },
                bookingParticipantCountExpression,
                0,
              ],
            },
          },
        },
      },
    ]),
    Booking.aggregate([
      { $match: activeMatch },
      {
        $group: {
          _id: null,
          inStudio: { $sum: bookingParticipantCountExpression },
        },
      },
    ]),
  ]);
  const dailyTotals = (dailyRows as any[])[0] ?? {};
  const liveTotals = (liveRows as any[])[0] ?? {};

  return {
    items: (bookings as any[]).map((booking) => {
      const product =
        booking.bookingProduct && typeof booking.bookingProduct === "object"
          ? booking.bookingProduct
          : null;
      const location =
        booking.location && typeof booking.location === "object"
          ? booking.location
          : null;
      const productCapacity = finiteNumber(product?.maxNumberOfParticipants);
      const locationCapacity = finiteNumber(location?.booking?.globalCapacity);

      return {
        id: entityId(booking._id),
        title: localizedText(product?.name, String(booking.tag || "booking")),
        productType: product?.type ? String(product.type) : null,
        start: asIso(booking.start),
        end: asIso(booking.end),
        locationId: entityId(booking.location),
        locationName: String(location?.name || ""),
        participantCount: participantCount(booking),
        capacity:
          productCapacity && productCapacity > 0
            ? productCapacity
            : locationCapacity && locationCapacity > 0
              ? locationCapacity
              : null,
        status: String(booking.status || ""),
      };
    }),
    booked: nonNegativeNumber(dailyTotals.booked),
    unpaidBookings: nonNegativeNumber(dailyTotals.unpaidBookings),
    expectedVisitors: nonNegativeNumber(dailyTotals.expectedVisitors),
    inStudio: nonNegativeNumber(liveTotals.inStudio),
  };
};

const reportHasSource = (report: any, source: string): boolean =>
  Array.isArray(report?.coverage?.available) &&
  report.coverage.available.includes(source);

const reportMetric = (report: any, key: string): number | null =>
  finiteNumber(report?.summary?.[key]?.value);

const deduplicateCoverageEntries = (
  entries: DashboardCoverageEntry[],
): DashboardCoverageEntry[] => {
  const byKey = new Map<string, DashboardCoverageEntry>();

  for (const entry of entries) {
    byKey.set(`${entry.source}:${entry.reason}`, entry);
  }

  return [...byKey.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.reason.localeCompare(right.reason),
  );
};

const buildOpportunity = ({
  bookings,
  occupancy,
  lowStock,
  courseCapacity,
}: {
  bookings: { available: boolean; value: number | null };
  occupancy: { available: boolean; value: number | null };
  lowStock: { available: boolean; value: number | null };
  courseCapacity: CourseCapacityAdvisorSignal | null;
}) => {
  if (courseCapacity) {
    return {
      available: true,
      key: courseCapacity.key,
      value: courseCapacity.value,
      href: "/app/products?category=classesEvents",
      actionKey: "reviewCourseCapacity" as const,
      source: "deterministic" as const,
      details: courseCapacity,
    };
  }

  if (bookings.available && bookings.value === 0) {
    return {
      available: true,
      key: "noBookings" as const,
      value: 0,
      href: "/app/products?action=create",
      actionKey: "createOffer" as const,
      source: "deterministic" as const,
    };
  }

  if (occupancy.available && occupancy.value !== null && occupancy.value < 60) {
    return {
      available: true,
      key: "lowOccupancy" as const,
      value: occupancy.value,
      href: "/app/products?action=create",
      actionKey: "createOffer" as const,
      source: "deterministic" as const,
    };
  }

  if (lowStock.available && lowStock.value !== null && lowStock.value > 0) {
    return {
      available: true,
      key: "inventoryReorder" as const,
      value: lowStock.value,
      href: "/app/operations?section=inventory",
      actionKey: "reviewInventory" as const,
      source: "deterministic" as const,
    };
  }

  return {
    available: bookings.available || occupancy.available || lowStock.available,
    key: null,
    value: null,
    href: null,
    actionKey: null,
    source: "deterministic" as const,
  };
};

export const buildDashboardOverview = async ({
  context,
  query,
  now = new Date(),
}: {
  context: DashboardContext;
  query: DashboardQuery;
  now?: Date;
}) => {
  const tenant = await TenantModel.findById(context.tenantId)
    .select("modules settings")
    .lean();
  if (!tenant) notFound("Workspace not found.");

  const modules =
    tenant.modules && typeof tenant.modules === "object"
      ? (tenant.modules as Record<string, unknown>)
      : {};
  const timezone = String(tenant.settings?.timezone || "UTC");
  const currency = String(tenant.settings?.currency || "CZK").toUpperCase();
  const tenantToday = resolveReportPeriod({
    query: {
      compare: false,
      granularity: REPORT_GRANULARITY.DAY,
    },
    timezone,
    now,
  }).current.to;
  const date = query.date || tenantToday;
  const period = resolveReportPeriod({
    query: {
      from: date,
      to: date,
      compare: false,
      granularity: REPORT_GRANULARITY.DAY,
    },
    timezone,
    now,
  }).current;
  const scope = await resolveReportLocationScope({
    context,
    locationId: query.locationId,
  });
  const reportContext = {
    tenantId: context.tenantId,
    userId: context.userId,
    access: context.access,
  };
  const hasNoAccessibleLocation =
    !scope.unrestricted && scope.locationIds.length === 0;
  const milestoneLocationIds =
    context.access.locationAccess.mode === "selected"
      ? context.access.locationAccess.locationIds
      : null;
  const hasNoMilestoneLocation =
    milestoneLocationIds !== null && milestoneLocationIds.length === 0;
  const reportPromise = hasNoAccessibleLocation
    ? Promise.resolve(null)
    : reportService.overview({
        context: reportContext,
        query: {
          from: date,
          to: date,
          ...(query.locationId ? { locationId: query.locationId } : {}),
          compare: false,
          granularity: REPORT_GRANULARITY.DAY,
        },
        now,
      });

  const unavailable: DashboardCoverageEntry[] = [];
  const available = new Set<string>();
  const limitations = new Set<string>();
  const scheduleReason = hasNoAccessibleLocation
    ? "location_scope_empty"
    : availabilityReason({
        enabled: moduleEnabled(modules, TENANT_MODULE.BOOKINGS),
        permitted: permissionAvailable(
          context,
          WORKSPACE_PERMISSION.BOOKINGS_VIEW,
        ),
      });
  const firstBookingReason = hasNoMilestoneLocation
    ? "location_scope_empty"
    : availabilityReason({
        enabled:
          moduleEnabled(modules, TENANT_MODULE.BOOKINGS) ||
          moduleEnabled(modules, TENANT_MODULE.COURSES),
        permitted: permissionAvailable(
          context,
          WORKSPACE_PERMISSION.BOOKINGS_VIEW,
        ),
      });
  const courseCapacityReason = hasNoAccessibleLocation
    ? "location_scope_empty"
    : availabilityReason({
        enabled:
          moduleEnabled(modules, TENANT_MODULE.BOOKINGS) &&
          moduleEnabled(modules, TENANT_MODULE.COURSES),
        permitted:
          permissionAvailable(context, WORKSPACE_PERMISSION.BOOKINGS_VIEW) &&
          permissionAvailable(context, WORKSPACE_PERMISSION.COURSES_VIEW),
      });

  if (scheduleReason) {
    unavailable.push({ source: "schedule", reason: scheduleReason });
  }
  if (firstBookingReason) {
    unavailable.push({
      source: "firstCustomerBooking",
      reason: firstBookingReason,
    });
  }
  if (courseCapacityReason) {
    unavailable.push({
      source: "courseCapacityAdvisor",
      reason: courseCapacityReason,
    });
  }

  const schedulePromise = scheduleReason
    ? Promise.resolve<ScheduleSource | null>(null)
    : loadScheduleSource({
        context,
        locationIds: scope.locationIds,
        period,
        now,
      });
  const firstBookingPromise = firstBookingReason
    ? Promise.resolve<boolean | null>(null)
    : loadFirstCustomerBookingMilestone({
        tenantId: context.tenantId,
        locationIds: milestoneLocationIds,
      });
  const courseCapacityPromise = courseCapacityReason
    ? Promise.resolve(null)
    : loadCourseCapacityAdvisor({
        tenantId: context.tenantId,
        locationIds: scope.locationIds,
        timezone,
        now,
      });
  const signalsPromise = loadDashboardSignals({
    context,
    modules,
    locationIds: scope.locationIds,
  });

  const [
    reportResult,
    scheduleResult,
    firstBookingResult,
    courseCapacityResult,
    signalsResult,
  ] = await Promise.allSettled([
    reportPromise,
    schedulePromise,
    firstBookingPromise,
    courseCapacityPromise,
    signalsPromise,
  ]);
  const report =
    reportResult.status === "fulfilled" ? reportResult.value : null;
  const schedule =
    scheduleResult.status === "fulfilled" ? scheduleResult.value : null;
  const firstCustomerBooking =
    firstBookingResult.status === "fulfilled" ? firstBookingResult.value : null;
  const courseCapacity =
    courseCapacityResult.status === "fulfilled"
      ? courseCapacityResult.value
      : null;
  const loadedSignals =
    signalsResult.status === "fulfilled" ? signalsResult.value : null;
  const signals: DashboardSignals = {
    messages: loadedSignals?.messages ?? {
      available: false,
      reason: "source_temporarily_unavailable",
      unreadCount: null,
      items: null,
    },
    tasks: loadedSignals?.tasks ?? {
      available: false,
      reason: "source_temporarily_unavailable",
      openCount: null,
      items: null,
    },
  };

  if (report) {
    for (const source of report.coverage?.available || []) {
      available.add(String(source));
    }
    for (const entry of report.coverage?.unavailable || []) {
      unavailable.push({
        source: String(entry.source),
        reason: String(entry.reason),
      });
    }
    for (const limitation of report.coverage?.limitations || []) {
      limitations.add(String(limitation));
    }
  } else if (!hasNoAccessibleLocation) {
    unavailable.push({
      source: "reports",
      reason: "source_temporarily_unavailable",
    });
  } else {
    unavailable.push({
      source: "dashboard",
      reason: "location_scope_empty",
    });
  }

  if (!scheduleReason) {
    if (schedule) {
      available.add("schedule");
    } else {
      unavailable.push({
        source: "schedule",
        reason: "source_temporarily_unavailable",
      });
    }
  }

  if (!firstBookingReason) {
    if (firstCustomerBooking !== null) {
      available.add("firstCustomerBooking");
    } else {
      unavailable.push({
        source: "firstCustomerBooking",
        reason: "source_temporarily_unavailable",
      });
    }
  }

  if (!courseCapacityReason) {
    if (courseCapacity) {
      available.add("courseCapacityAdvisor");
      limitations.add(
        "Course-capacity advice uses the current product capacity for recent historical sessions.",
      );
    } else {
      unavailable.push({
        source: "courseCapacityAdvisor",
        reason: "source_temporarily_unavailable",
      });
    }
  }

  for (const [source, signal] of [
    ["communications", signals.messages],
    ["staffTaskSignals", signals.tasks],
  ] as const) {
    if (signal.available) {
      available.add(source);
    } else {
      unavailable.push({
        source,
        reason: signal.reason,
      });
    }
  }

  if (schedule) {
    limitations.add(
      "In-studio attendance is inferred from active confirmed bookings, not verified check-ins.",
    );
  }

  const bookingsAvailable = reportHasSource(report, "bookings");
  const salesAvailable = reportHasSource(report, "sales");
  const customersAvailable = reportHasSource(report, "customers");
  const inventoryAvailable = reportHasSource(report, "inventory");
  const staffTasksAvailable = reportHasSource(report, "staffTasks");
  const bookingValue =
    reportMetric(report, "bookings") ?? schedule?.booked ?? null;
  const occupancyValue = reportMetric(report, "utilizationPercent");
  const revenueValue = reportMetric(report, "netSales");
  const newCustomersValue = finiteNumber(report?.customers?.new);
  const lowStockValue = finiteNumber(
    report?.operations?.inventory?.lowStockItems,
  );
  const overdueTasksValue = finiteNumber(
    report?.operations?.staffTasks?.overdue,
  );
  const bookingHeatmap = Array.isArray(report?.bookings?.heatmap)
    ? report.bookings.heatmap
    : null;
  /*
   * Noon UTC preserves the calendar date independently of the workspace's
   * positive or negative UTC offset. Report heatmap weekdays are Monday-first.
   */
  const selectedWeekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  const seriesPoints =
    bookingHeatmap === null
      ? null
      : bookingHeatmap
          .filter(
            (point: any) =>
              Number(point?.weekday) === (selectedWeekday + 6) % 7,
          )
          .map((point: any) => ({
            label: `${String(Number(point.hour || 0)).padStart(2, "0")}:00`,
            value: finiteNumber(point.utilizationPercent),
          }));

  const occupancy = {
    available: bookingsAvailable && occupancyValue !== null,
    value: bookingsAvailable ? occupancyValue : null,
    unit: "percent" as const,
  };
  const bookings = {
    available:
      (bookingsAvailable || schedule !== null) && bookingValue !== null,
    value: bookingsAvailable || schedule !== null ? bookingValue : null,
  };
  const lowStock = {
    available: inventoryAvailable && lowStockValue !== null,
    value: inventoryAvailable ? lowStockValue : null,
  };
  const deduplicatedUnavailable = deduplicateCoverageEntries(unavailable);

  return {
    metadata: {
      date,
      timezone,
      generatedAt: now.toISOString(),
      locationId: scope.requestedLocationId,
      locationIds: [...scope.locationIds],
      currency,
    },
    coverage: {
      available: [...available].sort(),
      unavailable: deduplicatedUnavailable,
      limitations: [...limitations].sort(),
      complete: !deduplicatedUnavailable.some(
        (entry) => entry.reason !== "module_disabled",
      ),
    },
    today: {
      available: schedule !== null,
      schedule: schedule?.items ?? null,
    },
    milestones: {
      firstCustomerBooking: {
        applicable:
          !firstBookingReason || firstBookingReason !== "module_disabled",
        available: firstCustomerBooking !== null,
        achieved: firstCustomerBooking,
      },
    },
    flow: [
      {
        key: "booked",
        value: bookings.available ? bookings.value : null,
        unit: "bookings",
        available: bookings.available,
        href: flowHref.booked,
      },
      {
        key: "arriving",
        value: schedule?.expectedVisitors ?? null,
        unit: "people",
        available:
          schedule?.expectedVisitors !== null &&
          schedule?.expectedVisitors !== undefined,
        href: flowHref.arriving,
      },
      {
        key: "inStudio",
        value: schedule?.inStudio ?? null,
        unit: "people",
        available:
          schedule?.inStudio !== null && schedule?.inStudio !== undefined,
        href: flowHref.inStudio,
      },
    ],
    attention: [
      {
        key: "unpaidBookings",
        count: schedule?.unpaidBookings ?? null,
        available: schedule !== null,
        severity: "warning",
        href: attentionHref.unpaidBookings,
      },
      {
        key: "lowStock",
        count: lowStock.available ? lowStock.value : null,
        available: lowStock.available,
        severity: "warning",
        href: attentionHref.lowStock,
      },
      {
        key: "overdueTasks",
        count:
          staffTasksAvailable && overdueTasksValue !== null
            ? overdueTasksValue
            : null,
        available: staffTasksAvailable && overdueTasksValue !== null,
        severity: "warning",
        href: attentionHref.overdueTasks,
      },
    ],
    businessPulse: {
      occupancy,
      revenue: {
        available: salesAvailable && revenueValue !== null,
        valueMinor: salesAvailable ? revenueValue : null,
        currency,
      },
      bookings,
      newCustomers: {
        available: customersAvailable && newCustomersValue !== null,
        value: customersAvailable ? newCustomersValue : null,
      },
      series: {
        available: bookingsAvailable && seriesPoints !== null,
        key: "utilization",
        points: bookingsAvailable ? seriesPoints : null,
      },
    },
    signals,
    opportunity: buildOpportunity({
      bookings,
      occupancy,
      lowStock,
      courseCapacity: courseCapacity?.signal ?? null,
    }),
  };
};

export const dashboardService = {
  overview: buildDashboardOverview,
};
