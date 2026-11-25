import {
  allocateOrderForReport,
  allocateMinorUnitsByWeight,
  minorUnits,
} from "./reports.allocation.js";
export {
  allocateOrderForReport,
  allocateMinorUnitsByWeight,
} from "./reports.allocation.js";
import {
  iterateReportCashReceipts,
  resolveReportCashSources,
  firstReportPaymentDates,
  allocateReportReceiptCash,
} from "./reports.cash.js";
import dayjs from "dayjs";
import { activeBookingParticipants } from "@/modules/booking/booking.attendance-read.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import Booking from "@/modules/booking/booking.model.js";
import {
  BOOKING_STATUS,
  BOOKING_TAG,
  CLASS_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import {
  InventoryAudit,
  InventoryItem,
  InventoryMovement,
  ReorderRequest,
} from "@/modules/inventory/inventory.model.js";
import {
  INVENTORY_AUDIT_STATUS,
  INVENTORY_MOVEMENT_REASON,
  INVENTORY_MOVEMENT_TYPE,
  REORDER_STATUS,
} from "@/modules/inventory/inventory.constants.js";
import LocationModel from "@/modules/location/location.model.js";
import Order from "@/modules/order/order.model.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import Product from "@/modules/product/product.model.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import StaffTaskModel from "@/modules/staff/staff-task.model.js";
import { STAFF_TASK_STATUS } from "@/modules/staff/staff.constants.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/index.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import {
  isStudioCommerceCurrency,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";

import {
  addTenantCalendarDays,
  buildReportBuckets,
  isInReportPeriod,
  reportBucketFor,
  resolveReportPeriod,
} from "./reports.date.js";
import {
  matchesReportLocation,
  orderLocationFilter,
  resolveReportLocationScope,
} from "./reports.scope.js";
import {
  buildCourseUtilizationSeries,
  getReportPlanEntitlement,
} from "./report-plan-entitlements.js";
import type {
  ReportContext,
  ReportCoverage,
  ReportKpi,
  ReportLocationScope,
  ReportPeriod,
  ReportQuery,
  ResolvedReportGranularity,
  ResolvedReportPeriod,
} from "./reports.types.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const round = (value: number, digits = 2): number => {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

export const changePercent = (
  current: number | null,
  previous: number | null,
): number | null => {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return round(((current - previous) / Math.abs(previous)) * 100);
};

const kpi = (value: number | null, previous: number | null): ReportKpi => ({
  value,
  previous,
  changePercent: changePercent(value, previous),
});

const hasPermission = (
  context: ReportContext,
  permission: (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION],
) => hasWorkspacePermission(context.access, permission);

const asDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date;
};

const id = (value: unknown): string => String(value ?? "").trim();

const periodForDate = (
  value: Date | null,
  periods: ResolvedReportPeriod,
): "current" | "comparison" | null => {
  if (isInReportPeriod(value, periods.current)) return "current";
  if (isInReportPeriod(value, periods.comparison)) return "comparison";
  return null;
};

type CoverageBuilder = {
  available: Set<string>;
  unavailable: Array<{ source: string; reason: string }>;
  limitations: Set<string>;
};

const sourceAvailability = ({
  coverage,
  source,
  moduleEnabled,
  permissions,
}: {
  coverage: CoverageBuilder;
  source: string;
  moduleEnabled: boolean;
  permissions: boolean[];
}): boolean => {
  if (!moduleEnabled) {
    coverage.unavailable.push({ source, reason: "module_disabled" });
    return false;
  }
  if (permissions.some((allowed) => !allowed)) {
    coverage.unavailable.push({ source, reason: "permission_required" });
    return false;
  }
  coverage.available.add(source);
  return true;
};

type ReportTopProductAccumulator = {
  productId: string | null;
  name: string;
  quantity: number;
  netSalesMinor: number;
  grossSalesMinor: number;
  netSalesComplete: boolean;
};

export const finalizeTopProducts = (products: ReportTopProductAccumulator[]) =>
  products
    .map(({ netSalesComplete, ...product }) => ({
      ...product,
      netSalesMinor: netSalesComplete ? product.netSalesMinor : null,
    }))
    .sort((a, b) => {
      if (a.netSalesMinor === null && b.netSalesMinor !== null) return 1;
      if (a.netSalesMinor !== null && b.netSalesMinor === null) return -1;
      if (a.netSalesMinor !== null && b.netSalesMinor !== null) {
        const netDifference = b.netSalesMinor - a.netSalesMinor;
        if (netDifference) return netDifference;
      }
      return (
        b.grossSalesMinor - a.grossSalesMinor || a.name.localeCompare(b.name)
      );
    });

const buildSales = async ({
  context,
  tenant,
  scope,
  periods,
  timezone,
  currency,
  coverage,
  productsAllowed,
  courseOnly,
  now,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  timezone: string;
  currency: string;
  coverage: CoverageBuilder;
  productsAllowed: boolean;
  courseOnly: boolean;
  now: Date;
}) => {
  const available = sourceAvailability({
    coverage,
    source: "sales",
    moduleEnabled: tenant.modules?.[TENANT_MODULE.PAYMENTS] === true,
    permissions: [
      hasPermission(context, WORKSPACE_PERMISSION.ORDERS_VIEW),
      hasPermission(context, WORKSPACE_PERMISSION.PAYMENTS_VIEW),
    ],
  });
  const sources = resolveReportCashSources({ context, scope, tenant });
  if (!available)
    return {
      report: null,
      series: new Map<string, number | null>(),
      orders: [],
      sources,
    };
  sources.limitations.forEach((value) => coverage.limitations.add(value));
  const cashExplanation =
    "Cash paid in the selected payment-date period, less successful external refunds recorded at calculation time. Later refunds revise the original payment month. Stored-value purchases count once; wallet, voucher and membership-benefit redemptions collect no new cash. This is not profit or tax-exclusive revenue.";
  if (courseOnly)
    coverage.limitations.add(
      "Limited-plan cash includes only line items linked to identifiable course products; unclassifiable historical receipts are unavailable.",
    );
  type Total = { amount: number; complete: boolean; payments: number };
  const empty = (): Total => ({ amount: 0, complete: true, payments: 0 });
  const totals = new Map<string, { current: Total; comparison: Total }>();
  const series = new Map<string, number | null>();
  const months = new Map<string, Total>();
  const linked = new Map<
    string,
    {
      createdBy: string;
      currency: string;
      _reportPeriod: string;
      _reportNetSalesMinor: number | null;
    }
  >();
  const methods = new Map<string, number | null>();
  const top = new Map<string, ReportTopProductAccumulator>();
  let unknownDate = false,
    unknownCurrency = false,
    unknownPayer = false;
  const add = (target: Total, amount: number | null) => {
    target.payments++;
    if (amount === null || !Number.isSafeInteger(target.amount + amount))
      target.complete = false;
    else target.amount += amount;
  };
  for await (const receipt of iterateReportCashReceipts({
    context,
    scope,
    period: {
      start: periods.queryStart,
      endExclusive: periods.queryEndExclusive,
    },
    now,
    sources,
  })) {
    const periodKey = receipt.paidAt
      ? periodForDate(receipt.paidAt, periods)
      : null;
    if (!receipt.paidAt) {
      unknownDate = true;
      continue;
    }
    if (!periodKey) continue;
    if (!receipt.currency) {
      unknownCurrency = true;
      continue;
    }
    if (receipt.customerId && receipt.paidMinor === null) unknownPayer = true;
    const allocated = allocateReportReceiptCash(receipt, scope);
    if (receipt.customerId && allocated.paidMinor === null) unknownPayer = true;
    // Tax snapshots do not determine cash. Other allocation limitations remain visible.
    for (const note of allocated.limitations)
      if (!note.startsWith("Tax-exclusive")) coverage.limitations.add(note);
    if (allocated.paidMinor === 0) continue;
    const amount = allocated.cashMinor;
    const group = totals.get(receipt.currency) ?? {
      current: empty(),
      comparison: empty(),
    };
    add(group[periodKey], amount);
    totals.set(receipt.currency, group);
    if (
      receipt.customerId &&
      receipt.paidMinor !== null &&
      receipt.paidMinor > 0
    ) {
      const key = `${periodKey}:${receipt.currency}:${receipt.customerId}`;
      const previous = linked.get(key);
      const combined =
        previous?._reportNetSalesMinor === null || amount === null
          ? null
          : (previous?._reportNetSalesMinor ?? 0) + amount;
      linked.set(key, {
        createdBy: receipt.customerId,
        currency: receipt.currency,
        _reportPeriod: periodKey,
        _reportNetSalesMinor:
          combined !== null && Number.isSafeInteger(combined) ? combined : null,
      });
    }
    if (periodKey !== "current" || receipt.currency !== currency) continue;
    const bucket = reportBucketFor({
      value: receipt.paidAt,
      timezone,
      granularity: periods.granularity,
    });
    const old = series.get(bucket);
    const combined =
      old === null || amount === null ? null : (old ?? 0) + amount;
    series.set(
      bucket,
      combined !== null && Number.isSafeInteger(combined) ? combined : null,
    );
    const month = dayjs(receipt.paidAt).tz(timezone).format("YYYY-MM");
    const monthly = months.get(month) ?? empty();
    add(monthly, amount);
    months.set(month, monthly);
    {
      const key =
        receipt.source === "order" ? "external_payment" : receipt.source;
      const previous = methods.get(key);
      const sum =
        previous === null || amount === null ? null : (previous ?? 0) + amount;
      methods.set(key, sum !== null && Number.isSafeInteger(sum) ? sum : null);
    }
    if (productsAllowed && receipt.order && allocated.allocation) {
      const lines = allocated.allocation.lines;
      const weights = new Map<string, number>(
        lines.map((line: any, index: number) => [
          String(index),
          minorUnits(line._reportGrossAmountMinor),
        ]),
      );
      const ambiguousActivityRefund =
        receipt.cashMinor !== null &&
        receipt.paidMinor !== null &&
        receipt.cashMinor > 0 &&
        receipt.cashMinor < receipt.paidMinor &&
        receipt.order.lineItems?.length > 1;
      if (ambiguousActivityRefund)
        coverage.limitations.add(
          "Activity cash is unavailable for partially refunded multi-line payments without reliable refund-to-line attribution; the overall payment and monthly cash remain known.",
        );
      const distributed =
        amount === null || ambiguousActivityRefund
          ? null
          : allocateMinorUnitsByWeight(amount, weights);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index],
          key =
            id(line.product) || `description:${String(line.description || "")}`;
        const item = top.get(key) ?? {
          productId: id(line.product) || null,
          name: String(line.description || "Unnamed activity"),
          quantity: 0,
          netSalesMinor: 0,
          grossSalesMinor: 0,
          netSalesComplete: true,
        };
        item.quantity +=
          Math.max(Number(line.quantity ?? 0), 0) *
          Math.max(Number(line._reportShare ?? 1), 0);
        if (distributed === null) item.netSalesComplete = false;
        else {
          const sum =
            item.netSalesMinor + (distributed.get(String(index)) ?? 0);
          if (Number.isSafeInteger(sum)) item.netSalesMinor = sum;
          else item.netSalesComplete = false;
        }
        top.set(key, item);
      }
    }
  }
  const unknown = unknownDate || unknownCurrency || !sources.complete;
  if (unknownDate)
    coverage.limitations.add(
      "Some settled receipts have no reliable payment date; period cash and monthly ranking are unavailable.",
    );
  if (unknownCurrency)
    coverage.limitations.add(
      "Some settled receipts have no reliable currency; period cash and monthly ranking are unavailable.",
    );
  if (
    [...totals.values()].some(
      (group) => !group.current.complete || !group.comparison.complete,
    )
  )
    coverage.limitations.add(
      "Some recorded payments or refund allocations are incomplete or require review; affected cash totals are unavailable.",
    );
  const primary = totals.get(currency) ?? {
    current: empty(),
    comparison: empty(),
  };
  const value = (total: Total) =>
    unknown || !total.complete ? null : total.amount;
  if (unknown)
    for (const bucket of buildReportBuckets({
      period: periods.current,
      timezone,
      granularity: periods.granularity,
    }))
      series.set(bucket.key, null);
  const monthlyRanking = buildCashMonthlyRanking({
    period: periods.current,
    timezone,
    now,
    months,
    unknown,
  });
  const eligible = monthlyRanking.filter((row) => row.completeMonth);
  const bestMonth =
    eligible.length && eligible.every((row) => row.dataComplete)
      ? ([...eligible]
          .filter((row) => (row.cashReceivedMinor ?? 0) > 0)
          .sort(
            (a, b) =>
              b.cashReceivedMinor! - a.cashReceivedMinor! ||
              a.month.localeCompare(b.month),
          )[0] ?? null)
      : null;
  const totalsByCurrency = [...totals]
    .map(([code, group]) => ({
      currency: code,
      cashReceivedMinor: value(group.current),
      netSalesMinor: value(group.current),
      paidAmountMinor: value(group.current),
      orders: group.current.payments,
      grossSalesMinor: null,
      discountsMinor: null,
      taxMinor: null,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  if (totalsByCurrency.some((row) => row.currency !== currency))
    coverage.limitations.add(
      `Primary cash KPIs include ${currency} only; other currencies are separated in totalsByCurrency.`,
    );
  return {
    report: {
      currency,
      cashReceivedMinor: value(primary.current),
      netSalesMinor: value(primary.current),
      grossSalesMinor: null,
      discountsMinor: null,
      taxMinor: null,
      refundsMinor: null,
      orders: primary.current.payments,
      paymentCount: primary.current.payments,
      averageOrderValueMinor:
        value(primary.current) === null
          ? null
          : primary.current.payments
            ? Math.round(primary.current.amount / primary.current.payments)
            : 0,
      paymentMethods: [...methods]
        .map(([method, amountMinor]) => ({
          method,
          amountMinor: unknown ? null : amountMinor,
        }))
        .sort((a, b) => (b.amountMinor ?? -1) - (a.amountMinor ?? -1)),
      paymentMethodsComplete:
        !unknown && [...methods.values()].every((amount) => amount !== null),
      totalsByCurrency,
      topProducts: productsAllowed
        ? finalizeTopProducts([...top.values()])
            .slice(0, 10)
            .map(({ grossSalesMinor: _gross, ...row }) => ({
              ...row,
              netSalesMinor:
                value(primary.current) === null ? null : row.netSalesMinor,
              cashReceivedMinor:
                value(primary.current) === null ? null : row.netSalesMinor,
              grossSalesMinor: null,
            }))
        : null,
      topProductsComplete:
        productsAllowed &&
        value(primary.current) !== null &&
        [...top.values()].every((row) => row.netSalesComplete),
      monthlyRanking,
      bestMonth,
      moneyBasisExplanation: cashExplanation,
      limitations: [
        ...sources.limitations,
        ...(unknownDate || unknownCurrency
          ? [
              "Unknown payment dates or currencies prevent a complete period total.",
            ]
          : []),
        ...(!primary.current.complete
          ? [
              "Some payments or refund allocations are incomplete or require review; cash totals and affected breakdowns are unavailable.",
            ]
          : []),
      ],
    },
    primaryCurrentNetSalesMinor: value(primary.current),
    primaryComparisonNetSalesMinor: periods.comparison
      ? value(primary.comparison)
      : null,
    series,
    orders: [...linked.values()],
    sources,
    unknown,
    unknownPayer,
  };
};

export const buildCashMonthlyRanking = ({
  period,
  timezone,
  now,
  months,
  unknown = false,
}: {
  period: ReportPeriod;
  timezone: string;
  now: Date;
  months: Map<string, { amount: number; complete: boolean; payments: number }>;
  unknown?: boolean;
}) => {
  const result: Array<{
    month: string;
    periodStart: string;
    periodEnd: string;
    cashReceivedMinor: number | null;
    paymentCount: number;
    completeMonth: boolean;
    dataComplete: boolean;
  }> = [];
  let cursor = dayjs(period.start).tz(timezone).startOf("month");
  const last = dayjs(period.endExclusive).tz(timezone);
  while (cursor.isBefore(last)) {
    const month = cursor.format("YYYY-MM");
    const start = dayjs.tz(`${month}-01`, timezone).startOf("day");
    const nextMonth = start.add(1, "month").format("YYYY-MM");
    const end = dayjs.tz(`${nextMonth}-01`, timezone).startOf("day");
    const total = months.get(month) ?? {
      amount: 0,
      complete: true,
      payments: 0,
    };
    result.push({
      month,
      periodStart: start.format("YYYY-MM-DD"),
      periodEnd: end.subtract(1, "day").format("YYYY-MM-DD"),
      cashReceivedMinor: unknown || !total.complete ? null : total.amount,
      paymentCount: total.payments,
      completeMonth:
        start.toDate() >= period.start &&
        end.toDate() <= period.endExclusive &&
        end.toDate() <= now,
      dataComplete: !unknown && total.complete,
    });
    cursor = end;
  }
  return result;
};

const isClassBookingTag = (tag: unknown): boolean =>
  (CLASS_BOOKING_TAGS as readonly string[]).includes(String(tag ?? ""));

export const bookingSeats = (booking: any): number => {
  const participants = activeBookingParticipants(booking).length;
  if (booking.attendanceManaged === true) return participants;
  const guests = Math.max(Number(booking.numberOfGuests ?? 0), 0);
  if (isClassBookingTag(booking.tag)) {
    return Math.max(participants, guests);
  }
  return Math.max(participants, guests, 1);
};

export const bookingReservations = (booking: any): number => {
  if (!isClassBookingTag(booking.tag)) return 1;
  const bookingOrders = new Set(
    (booking.orders ?? [])
      .map((orderId: unknown) => id(orderId))
      .filter(Boolean),
  );
  if (bookingOrders.size) return bookingOrders.size;
  // Attendance-managed rows retain refunded order references for webhook
  // idempotency. Only the current booking.orders list owns paid reservations.
  if (booking.attendanceManaged === true)
    return Number(booking.numberOfGuests ?? 0) > 0 ? 1 : 0;
  const orders = new Set(
    (booking.participants ?? [])
      .map((participant: any) => id(participant.order))
      .filter(Boolean),
  );
  if (orders.size) return orders.size;
  return Number(booking.numberOfGuests ?? 0) > 0 ? 1 : 0;
};

export const openingHoursCapacity = ({
  locations,
  period,
  timezone,
  granularity,
}: {
  locations: any[];
  period: ReportPeriod;
  timezone: string;
  granularity: ResolvedReportGranularity;
}) => {
  const weekdayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const byBucket = new Map<string, number>();
  const heatmap = new Map<string, number>();
  let total = 0;
  let cursor = dayjs(period.start).tz(timezone).startOf("day");
  const end = dayjs(period.endExclusive).tz(timezone);
  while (cursor.isBefore(end)) {
    for (const location of locations) {
      if (location.booking?.enabled === false) continue;
      const hours = location.openingHours?.[weekdayNames[cursor.day()]];
      if (!hours?.isOpen) continue;
      const [openHour, openMinute] = String(hours.openTime || "00:00")
        .split(":")
        .map(Number);
      const [rawCloseHour, closeMinute] = String(hours.closeTime || "24:00")
        .split(":")
        .map(Number);
      const closeHour = rawCloseHour === 24 ? 24 : rawCloseHour;
      const open = openHour + openMinute / 60;
      const close = closeHour + closeMinute / 60;
      const capacity = Math.max(
        Number(location.booking?.globalCapacity ?? 0),
        0,
      );
      if (close <= open || capacity <= 0) continue;
      const capacityHours = (close - open) * capacity;
      total += capacityHours;
      const bucket = reportBucketFor({
        value: cursor.toDate(),
        timezone,
        granularity,
      });
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + capacityHours);
      for (let hour = Math.floor(open); hour < Math.ceil(close); hour += 1) {
        const overlap = Math.max(
          0,
          Math.min(close, hour + 1) - Math.max(open, hour),
        );
        const weekday = (cursor.day() + 6) % 7;
        const key = `${weekday}:${hour % 24}`;
        heatmap.set(key, (heatmap.get(key) ?? 0) + overlap * capacity);
      }
    }
    cursor = dayjs(addTenantCalendarDays(cursor.toDate(), 1, timezone)).tz(
      timezone,
    );
  }
  return { total, byBucket, heatmap };
};

export const reportBookingSegments = ({
  booking,
  period,
  timezone,
  granularity,
}: {
  booking: any;
  period: ReportPeriod;
  timezone: string;
  granularity: ResolvedReportGranularity;
}) => {
  const start = asDate(booking.start),
    end = asDate(booking.end);
  if (!start || !end || end <= start) return [];
  let cursor = new Date(Math.max(start.valueOf(), period.start.valueOf()));
  const finish = new Date(
    Math.min(end.valueOf(), period.endExclusive.valueOf()),
  );
  const result: Array<{
    key: string;
    weekday: number;
    hour: number;
    hours: number;
  }> = [];
  while (cursor < finish) {
    const local = dayjs(cursor).tz(timezone);
    const nextHour =
      cursor.valueOf() +
      (60 - local.minute()) * 60_000 -
      local.second() * 1_000 -
      local.millisecond();
    const next = new Date(Math.min(nextHour, finish.valueOf()));
    result.push({
      key: reportBucketFor({ value: cursor, timezone, granularity }),
      weekday: (local.day() + 6) % 7,
      hour: local.hour(),
      hours: (next.valueOf() - cursor.valueOf()) / 3_600_000,
    });
    cursor = next;
  }
  return result;
};

const buildBookings = async ({
  context,
  tenant,
  scope,
  periods,
  timezone,
  locations,
  coverage,
  coursesAllowed,
  courseOnly,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  timezone: string;
  locations: any[];
  coverage: CoverageBuilder;
  coursesAllowed: boolean;
  courseOnly: boolean;
}) => {
  const available = sourceAvailability({
    coverage,
    source: "bookings",
    moduleEnabled: tenant.modules?.[TENANT_MODULE.BOOKINGS] === true,
    permissions: [hasPermission(context, WORKSPACE_PERMISSION.BOOKINGS_VIEW)],
  });
  if (!available) {
    return {
      report: null,
      current: null,
      comparison: null,
      series: new Map(),
      seriesUtilization: new Map(),
      records: [],
    };
  }
  coverage.limitations.add(
    "No-show and attendance data are unavailable because bookings do not store authoritative attendance.",
  );
  if (!courseOnly) {
    coverage.limitations.add(
      "Studio utilization uses booked participant-hours divided by configured opening capacity-hours; private blocking and activity-specific capacity can make this an estimate.",
    );
  }

  const bookingRows = (await Booking.find({
    tenant: context.tenantId,
    location: { $in: scope.locationIds },
    $or: [
      { start: { $gte: periods.queryStart, $lt: periods.queryEndExclusive } },
      { start: { $lt: periods.queryStart }, end: { $gt: periods.queryStart } },
    ],
    tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
  })
    .select(
      "_id location participants orders start end bookingProduct bookingType status paymentStatus tag numberOfGuests isRoot attendanceManaged",
    )
    .lean()) as any[];

  const productIds =
    coursesAllowed || courseOnly
      ? [
          ...new Set(
            bookingRows
              .map((booking) => id(booking.bookingProduct))
              .filter(Boolean),
          ),
        ]
      : [];
  const products = productIds.length
    ? ((await Product.find({
        tenant: context.tenantId,
        _id: { $in: productIds },
      })
        .select("_id name type maxNumberOfParticipants")
        .lean()) as any[])
    : [];
  const productsById = new Map(
    products.map((product) => [id(product._id), product]),
  );
  const bookings = courseOnly
    ? bookingRows.filter((booking) => {
        const product = productsById.get(id(booking.bookingProduct));
        return (
          isClassBookingTag(booking.tag) ||
          COURSE_PRODUCT_TYPES.includes(product?.type as never)
        );
      })
    : bookingRows;
  if (courseOnly && bookings.length !== bookingRows.length) {
    coverage.limitations.add(
      "Limited-plan booking reports exclude open-studio and other non-course bookings.",
    );
  }

  const capacityLocations = locations.filter(
    (location) => location.isActive !== false,
  );
  if (!courseOnly) {
    if (capacityLocations.length !== locations.length) {
      coverage.limitations.add(
        "Utilization excludes inactive locations and uses current opening-hours and capacity settings for historical periods.",
      );
    } else {
      coverage.limitations.add(
        "Historical utilization uses current opening-hours and capacity settings.",
      );
    }
  } else {
    coverage.limitations.add(
      "Limited-plan utilization uses booked course seats divided by configured course capacity.",
    );
  }
  const capacities = courseOnly
    ? {
        current: { total: 0, byBucket: new Map(), heatmap: new Map() },
        comparison: periods.comparison
          ? { total: 0, byBucket: new Map(), heatmap: new Map() }
          : null,
      }
    : {
        current: openingHoursCapacity({
          locations: capacityLocations,
          period: periods.current,
          timezone,
          granularity: periods.granularity,
        }),
        comparison: periods.comparison
          ? openingHoursCapacity({
              locations: capacityLocations,
              period: periods.comparison,
              timezone,
              granularity: periods.granularity,
            })
          : null,
      };
  const stats = {
    current: {
      total: 0,
      participants: 0,
      cancellations: 0,
      bookedHours: 0,
      participantHours: 0,
    },
    comparison: {
      total: 0,
      participants: 0,
      cancellations: 0,
      bookedHours: 0,
      participantHours: 0,
    },
  };
  const typeTotals = new Map<string, { count: number; participants: number }>();
  const series = new Map<
    string,
    { bookings: number; participants: number; participantHours: number }
  >();
  const heat = new Map<
    string,
    { bookings: number; participants: number; bookedHours: number }
  >();
  const courseFill = new Map<
    string,
    {
      productId: string;
      name: string;
      sessions: number;
      bookedSeats: number;
      capacity: number;
    }
  >();
  let missingCourseCapacity = false;
  const courseCapacity = {
    current: { bookedSeats: 0, capacity: 0 },
    comparison: { bookedSeats: 0, capacity: 0 },
  };
  const courseCapacityByBucket = new Map<string, number>();
  const courseBookedSeatsByBucket = new Map<string, number>();

  const capacityLocationIds = new Set(
    capacityLocations.map((location) => String(location._id)),
  );
  for (const booking of bookings) {
    const start = asDate(booking.start);
    if (!start) continue;
    const periodKey = periodForDate(start, periods);
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      if (periodKey && !isClassBookingTag(booking.tag))
        stats[periodKey].cancellations += 1;
      continue;
    }
    if (booking.paymentStatus !== PAYMENT_STATUS.CONFIRMED) continue;
    const seats = bookingSeats(booking),
      reservations = bookingReservations(booking);
    const product = productsById.get(id(booking.bookingProduct));
    const courseBooking =
      isClassBookingTag(booking.tag) ||
      COURSE_PRODUCT_TYPES.includes(product?.type as never);
    const configuredCourseCapacity = courseBooking
      ? Math.max(Number(product?.maxNumberOfParticipants ?? 0), 0)
      : 0;
    const capacityVisible = capacityLocationIds.has(id(booking.location));
    // Reservations/participants belong to the start date; occupied time belongs
    // to each actual overlapping calendar bucket and excludes inactive capacity.
    for (const key of ["current", "comparison"] as const) {
      const period = key === "current" ? periods.current : periods.comparison;
      if (!period) continue;
      const segments = reportBookingSegments({
        booking,
        period,
        timezone,
        granularity: periods.granularity,
      });
      const hours = segments.reduce((sum, segment) => sum + segment.hours, 0);
      stats[key].bookedHours += hours;
      if (capacityVisible) stats[key].participantHours += seats * hours;
      if (periodKey === key) {
        stats[key].total += reservations;
        stats[key].participants += seats;
        if (
          courseBooking &&
          coursesAllowed &&
          configuredCourseCapacity > 0 &&
          capacityVisible
        ) {
          courseCapacity[key].bookedSeats += seats;
          courseCapacity[key].capacity += configuredCourseCapacity;
        }
      }
      if (key !== "current" || !capacityVisible) continue;
      for (const segment of segments) {
        const point = series.get(segment.key) ?? {
          bookings: 0,
          participants: 0,
          participantHours: 0,
        };
        point.participantHours += seats * segment.hours;
        series.set(segment.key, point);
        const heatKey = `${segment.weekday}:${segment.hour}`;
        const heatEntry = heat.get(heatKey) ?? {
          bookings: 0,
          participants: 0,
          bookedHours: 0,
        };
        heatEntry.bookings += reservations;
        heatEntry.participants += seats;
        heatEntry.bookedHours += seats * segment.hours;
        heat.set(heatKey, heatEntry);
      }
    }
    if (periodKey !== "current") continue;
    const type = String(booking.tag || booking.bookingType || "other");
    const typeEntry = typeTotals.get(type) ?? { count: 0, participants: 0 };
    typeEntry.count += reservations;
    typeEntry.participants += seats;
    typeTotals.set(type, typeEntry);
    const bucket = reportBucketFor({
      value: start,
      timezone,
      granularity: periods.granularity,
    });
    const point = series.get(bucket) ?? {
      bookings: 0,
      participants: 0,
      participantHours: 0,
    };
    point.bookings += reservations;
    point.participants += seats;
    series.set(bucket, point);
    if (
      courseBooking &&
      coursesAllowed &&
      configuredCourseCapacity > 0 &&
      capacityVisible
    ) {
      courseCapacityByBucket.set(
        bucket,
        (courseCapacityByBucket.get(bucket) ?? 0) + configuredCourseCapacity,
      );
      courseBookedSeatsByBucket.set(
        bucket,
        (courseBookedSeatsByBucket.get(bucket) ?? 0) + seats,
      );
    }
    if (coursesAllowed && courseBooking) {
      const capacity = Number(product?.maxNumberOfParticipants ?? 0);
      if (capacity <= 0) missingCourseCapacity = true;
      const productId = id(booking.bookingProduct);
      const entry = courseFill.get(productId) ?? {
        productId,
        name: String(product?.name || "Course"),
        sessions: 0,
        bookedSeats: 0,
        capacity: 0,
      };
      entry.sessions++;
      entry.bookedSeats += seats;
      if (capacity > 0) entry.capacity += capacity;
      courseFill.set(productId, entry);
    }
  }

  if (missingCourseCapacity) {
    coverage.limitations.add(
      "Course fill excludes sessions whose product has no configured capacity.",
    );
  }
  if (!coursesAllowed) {
    coverage.limitations.add(
      "Course fill is unavailable unless courses, bookings, and products can all be viewed.",
    );
  }
  coverage.limitations.add(
    "Course cancellation history is not authoritative; cancellations include non-course booking rows only.",
  );

  const currentUtilization = courseOnly
    ? courseCapacity.current.capacity > 0
      ? round(
          (courseCapacity.current.bookedSeats /
            courseCapacity.current.capacity) *
            100,
        )
      : null
    : capacities.current.total > 0
      ? round((stats.current.participantHours / capacities.current.total) * 100)
      : null;
  const comparisonUtilization = courseOnly
    ? periods.comparison && courseCapacity.comparison.capacity > 0
      ? round(
          (courseCapacity.comparison.bookedSeats /
            courseCapacity.comparison.capacity) *
            100,
        )
      : null
    : periods.comparison &&
        capacities.comparison &&
        capacities.comparison.total > 0
      ? round(
          (stats.comparison.participantHours / capacities.comparison.total) *
            100,
        )
      : null;
  const seriesUtilization = courseOnly
    ? buildCourseUtilizationSeries(
        courseCapacityByBucket,
        courseBookedSeatsByBucket,
      )
    : buildUtilizationSeries(capacities.current.byBucket, series);

  const heatKeys = new Set([
    ...capacities.current.heatmap.keys(),
    ...heat.keys(),
  ]);
  const heatmap = courseOnly
    ? []
    : [...heatKeys]
        .map((key) => {
          const entry = heat.get(key) ?? {
            bookings: 0,
            participants: 0,
            bookedHours: 0,
          };
          const [weekday, hour] = key.split(":").map(Number);
          const capacity = capacities.current.heatmap.get(key) ?? 0;
          return {
            weekday,
            hour,
            bookings: entry.bookings,
            participants: entry.participants,
            capacity: round(capacity),
            utilizationPercent:
              capacity > 0 ? round((entry.bookedHours / capacity) * 100) : null,
          };
        })
        .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);

  return {
    report: {
      total: stats.current.total,
      participants: stats.current.participants,
      cancellations: stats.current.cancellations,
      noShows: null,
      bookedHours: round(stats.current.bookedHours),
      utilizationPercent: currentUtilization,
      bookingTypes: [...typeTotals.entries()]
        .map(([type, values]) => ({ type, ...values }))
        .sort((a, b) => b.count - a.count),
      heatmap,
      courseFill: coursesAllowed
        ? [...courseFill.values()]
            .filter((entry) => entry.capacity > 0)
            .map((entry) => ({
              ...entry,
              fillPercent: round((entry.bookedSeats / entry.capacity) * 100),
            }))
            .sort((a, b) => b.fillPercent - a.fillPercent)
        : null,
      limitations: [
        "No-shows and attendance are unavailable.",
        courseOnly
          ? "Utilization is based on configured course capacity."
          : "Utilization is a deterministic capacity-hours estimate.",
      ],
    },
    current: {
      ...stats.current,
      utilizationPercent: currentUtilization,
    },
    comparison: periods.comparison
      ? {
          ...stats.comparison,
          utilizationPercent: comparisonUtilization,
        }
      : null,
    series,
    seriesUtilization,
    records: bookings,
  };
};

export const averageLinkedCustomerSpend = (
  orders: any[],
  currency: string,
): number | null => {
  const linkedOrders = orders.filter(
    (order) =>
      order._reportPeriod === "current" &&
      String(order.currency || "").toUpperCase() ===
        String(currency || "").toUpperCase() &&
      Boolean(id(order.createdBy)),
  );
  if (!linkedOrders.length) return null;
  if (
    linkedOrders.some(
      (order) =>
        order._reportNetSalesMinor === null ||
        !Number.isFinite(Number(order._reportNetSalesMinor)),
    )
  ) {
    return null;
  }
  const customers = new Set(
    linkedOrders.map((order) => id(order.createdBy)).filter(Boolean),
  );
  if (!customers.size) return null;
  const netSalesMinor = linkedOrders.reduce(
    (sum, order) => sum + Number(order._reportNetSalesMinor),
    0,
  );
  return Number.isSafeInteger(netSalesMinor)
    ? Math.round(netSalesMinor / customers.size)
    : null;
};

export const buildUtilizationSeries = (
  capacityByBucket: Map<string, number>,
  bookingSeries: Map<string, { participantHours: number }>,
): Map<string, number | null> => {
  const result = new Map<string, number | null>();
  for (const key of new Set([
    ...capacityByBucket.keys(),
    ...bookingSeries.keys(),
  ])) {
    const capacity = capacityByBucket.get(key) ?? 0;
    const participantHours = bookingSeries.get(key)?.participantHours ?? 0;
    result.set(
      key,
      capacity > 0 ? round((participantHours / capacity) * 100) : null,
    );
  }
  return result;
};

export const reportSeriesValue = (
  series: Map<string, number | null>,
  key: string,
): number | null => (series.has(key) ? series.get(key)! : 0);

const buildCustomers = async ({
  context,
  tenant,
  scope,
  periods,
  coverage,
  sales,
  courseOnly,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  coverage: CoverageBuilder;
  sales: any;
  courseOnly: boolean;
}) => {
  const moduleEnabled = tenant.modules?.[TENANT_MODULE.CUSTOMERS] === true;
  const permission = hasPermission(
    context,
    WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
  );
  if (
    !sourceAvailability({
      coverage,
      source: "customers",
      moduleEnabled,
      permissions: [permission],
    })
  )
    return { report: null, current: null, comparison: null };
  if (!sales.report) {
    coverage.available.delete("customers");
    coverage.unavailable.push({
      source: "customers",
      reason: "sales_source_required",
    });
    return { report: null, current: null, comparison: null };
  }

  if (sales.unknown || sales.unknownPayer)
    return {
      report: {
        active: null,
        activePaying: null,
        new: null,
        returning: null,
        returningRatePercent: null,
        averageSpendMinor: null,
        limitations: [
          "Some settled receipts have no reliable payment date, currency or paid amount; paying-customer classification is unavailable.",
        ],
      },
      current: null,
      comparison: null,
    };

  const currentIds = new Set<string>();
  const comparisonIds = new Set<string>();
  for (const order of sales.orders) {
    const customerId = id(order.createdBy);
    if (!customerId) continue;
    if (order._reportPeriod === "current") currentIds.add(customerId);
    if (order._reportPeriod === "comparison") comparisonIds.add(customerId);
  }
  if (courseOnly) {
    const limitedOverview = (ids: Set<string>, period: ReportPeriod | null) =>
      period
        ? {
            active: ids.size,
            new: null,
            returning: null,
            returningRatePercent: null,
          }
        : null;
    const current = limitedOverview(currentIds, periods.current)!;
    const comparison = limitedOverview(comparisonIds, periods.comparison);
    coverage.limitations.add(
      "Limited-plan customer lifecycle is not classified because historical non-course orders are intentionally excluded.",
    );
    return {
      report: {
        ...current,
        activePaying: current.active,
        averageSpendMinor: averageLinkedCustomerSpend(
          sales.orders,
          sales.report.currency,
        ),
        limitations: [
          "Active customers and average spend use course-linked orders only; new/returning classification is unavailable.",
        ],
      },
      current,
      comparison,
    };
  }

  coverage.limitations.add(
    "Paying customers are linked accounts with a cash receipt in the period, including receipts later refunded. First payment includes accessible order, voucher and membership cash sources; guest identity and merged accounts can affect counts.",
  );
  const allIds = [...new Set([...currentIds, ...comparisonIds])];
  const firstPaidAt = await firstReportPaymentDates({
    context,
    scope,
    customerIds: allIds,
    sources: sales.sources,
  });

  const classify = (ids: Set<string>, period: ReportPeriod | null) => {
    if (!period) return null;
    let fresh = 0;
    let returning = 0;
    for (const customerId of ids) {
      const first = firstPaidAt.get(customerId);
      if (!first)
        return {
          active: ids.size,
          new: null,
          returning: null,
          returningRatePercent: null,
        };
      if (first >= period.start) fresh += 1;
      else returning += 1;
    }
    return {
      active: ids.size,
      new: fresh,
      returning,
      returningRatePercent:
        ids.size > 0 ? round((returning / ids.size) * 100) : 0,
    };
  };
  const current = classify(currentIds, periods.current)!;
  const comparison = classify(comparisonIds, periods.comparison);
  return {
    report: {
      ...current,
      activePaying: current.active,
      averageSpendMinor: averageLinkedCustomerSpend(
        sales.orders,
        sales.report.currency,
      ),
      limitations: [
        "Customer lifecycle uses the first recorded cash payment from the accessible payment sources; stored-value purchases count once.",
        "Average customer cash uses recorded net cash from linked paying accounts in the workspace currency; guest receipts are excluded.",
      ],
    },
    current,
    comparison,
  };
};

const locationPredicate = (scope: ReportLocationScope, field: string) => ({
  [field]: { $in: scope.locationIds },
});

const buildInventory = async ({
  context,
  tenant,
  scope,
  periods,
  currency,
  coverage,
  now,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  currency: string;
  coverage: CoverageBuilder;
  now: Date;
}) => {
  if (
    !sourceAvailability({
      coverage,
      source: "inventory",
      moduleEnabled: tenant.modules?.[TENANT_MODULE.INVENTORY] === true,
      permissions: [
        hasPermission(context, WORKSPACE_PERMISSION.INVENTORY_VIEW),
      ],
    })
  )
    return null;
  const [movements, items, openReorders, audits] = await Promise.all([
    InventoryMovement.find({
      tenant: context.tenantId,
      ...locationPredicate(scope, "location"),
      createdAt: {
        $gte: periods.current.start,
        $lt: periods.current.endExclusive,
      },
    })
      .select("item type reason quantity totalWithoutVat currency")
      .lean(),
    InventoryItem.find({
      tenant: context.tenantId,
    })
      .select("_id unit isActive stockLevels")
      .lean(),
    ReorderRequest.countDocuments({
      tenant: context.tenantId,
      ...locationPredicate(scope, "location"),
      status: { $in: [REORDER_STATUS.OPEN, REORDER_STATUS.ORDERED] },
    }),
    InventoryAudit.find({
      tenant: context.tenantId,
      ...locationPredicate(scope, "location"),
      status: INVENTORY_AUDIT_STATUS.COMPLETED,
      completedAt: {
        $gte: periods.current.start,
        $lt: periods.current.endExclusive,
      },
    })
      .select("items")
      .lean(),
  ]);
  const itemUnits = new Map(
    (items as any[]).map((item) => [
      id(item._id),
      String(item.unit || "unknown"),
    ]),
  );
  const consumedByUnit = new Map<string, number>();
  const purchasedByUnit = new Map<string, number>();
  const differenceByUnit = new Map<string, number>();
  let purchaseCostWithoutVatMinor = 0;
  let mixedPurchaseCurrency = false;
  let missingPurchaseCurrency = false;
  let unknownUnit = false;
  const addUnitQuantity = (
    map: Map<string, number>,
    itemId: unknown,
    quantity: number,
  ) => {
    const unit = itemUnits.get(id(itemId)) || "unknown";
    if (unit === "unknown") unknownUnit = true;
    map.set(unit, (map.get(unit) ?? 0) + quantity);
  };
  for (const movement of movements as any[]) {
    if (movement.type === INVENTORY_MOVEMENT_TYPE.OUT) {
      addUnitQuantity(
        consumedByUnit,
        movement.item,
        Math.max(Number(movement.quantity ?? 0), 0),
      );
    }
    if (
      movement.type === INVENTORY_MOVEMENT_TYPE.IN &&
      movement.reason === INVENTORY_MOVEMENT_REASON.PURCHASE
    ) {
      addUnitQuantity(
        purchasedByUnit,
        movement.item,
        Math.max(Number(movement.quantity ?? 0), 0),
      );
      if (String(movement.currency || "").toUpperCase() === currency) {
        const amount = Math.max(Number(movement.totalWithoutVat ?? 0), 0);
        if (isStudioCommerceCurrency(currency)) {
          try {
            purchaseCostWithoutVatMinor += toCurrencyMinorUnits(
              amount,
              currency,
            );
          } catch {
            coverage.limitations.add(
              "An inventory purchase cost with invalid currency precision was excluded.",
            );
          }
        }
      } else if (movement.currency) {
        mixedPurchaseCurrency = true;
      } else {
        missingPurchaseCurrency = true;
      }
    }
  }
  if (mixedPurchaseCurrency) {
    coverage.limitations.add(
      `Inventory purchase cost includes ${currency} only; other currencies are not summed.`,
    );
  }
  if (missingPurchaseCurrency) {
    coverage.limitations.add(
      "Inventory purchase cost is unavailable because at least one legacy purchase has no currency.",
    );
  }
  const locationSet = new Set(scope.locationIds);
  const lowStockItems = (items as any[]).filter(
    (item) =>
      item.isActive !== false &&
      (item.stockLevels ?? []).some(
        (level: any) =>
          locationSet.has(id(level.location)) &&
          Number(level.minimumQuantity ?? 0) > 0 &&
          Number(level.currentQuantity ?? 0) <=
            Number(level.minimumQuantity ?? 0),
      ),
  ).length;
  for (const audit of audits as any[]) {
    for (const item of audit.items ?? []) {
      addUnitQuantity(
        differenceByUnit,
        item.item,
        Number(item.difference ?? 0),
      );
    }
  }
  if (unknownUnit) {
    coverage.limitations.add(
      "Inventory quantities for deleted or legacy items are grouped under the unknown unit.",
    );
  }
  const unitRows = (map: Map<string, number>) =>
    [...map.entries()]
      .map(([unit, quantity]) => ({ unit, quantity: round(quantity, 4) }))
      .sort((a, b) => a.unit.localeCompare(b.unit));
  return {
    asOf: now.toISOString(),
    consumptionByUnit: unitRows(consumedByUnit),
    purchasesByUnit: unitRows(purchasedByUnit),
    purchaseCostWithoutVatMinor: missingPurchaseCurrency
      ? null
      : purchaseCostWithoutVatMinor,
    openReorders,
    lowStockItems,
    stocktakeDifferenceByUnit: unitRows(differenceByUnit),
    limitations: [
      "Consumption sums OUT movements and excludes transfers and audit movements.",
      "Purchase cost is a minor-unit amount without VAT in the workspace currency.",
      "Reorder cost is unavailable until a purchase receipt creates an inventory movement.",
      "Open reorders and low-stock items are point-in-time snapshots at asOf.",
    ],
  };
};

const buildStaffTasks = async ({
  context,
  tenant,
  scope,
  periods,
  coverage,
  now,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  coverage: CoverageBuilder;
  now: Date;
}) => {
  if (
    !sourceAvailability({
      coverage,
      source: "staffTasks",
      moduleEnabled: tenant.modules?.[TENANT_MODULE.STAFF_TASKS] === true,
      permissions: [hasPermission(context, WORKSPACE_PERMISSION.TASKS_VIEW)],
    })
  )
    return null;
  const locationFilter = {
    $or: [
      { appliesToAllLocations: true },
      { appliesToAllLocations: false, locationId: null },
      { locationId: { $in: scope.locationIds } },
    ],
  };
  // open/overdue only ever need counts (see below), so they're counted in
  // MongoDB directly instead of fetching every still-open task into Node —
  // both correct (open/overdue task backlogs are unbounded over a tenant's
  // lifetime) and cheaper than the previous find()+filter()+.length.
  const openTaskFilter = {
    tenantId: context.tenantId,
    ...locationFilter,
    status: { $ne: STAFF_TASK_STATUS.DONE },
  } as any;
  const [completedRows, openCount, overdueCount, dueRows] = await Promise.all([
    StaffTaskModel.find({
      tenantId: context.tenantId,
      ...locationFilter,
      completedAt: { $gte: periods.queryStart, $lt: periods.queryEndExclusive },
      status: STAFF_TASK_STATUS.DONE,
    } as any)
      .select("completedAt")
      .lean(),
    StaffTaskModel.countDocuments(openTaskFilter),
    StaffTaskModel.countDocuments({ ...openTaskFilter, dueDate: { $lt: now } }),
    StaffTaskModel.find({
      tenantId: context.tenantId,
      ...locationFilter,
      dueDate: {
        $gte: periods.current.start,
        $lt: periods.current.endExclusive,
      },
    } as any)
      .select("status completedAt")
      .lean(),
  ]);
  let completed = 0;
  let previousCompleted = 0;
  for (const task of completedRows as any[]) {
    const period = periodForDate(asDate(task.completedAt), periods);
    if (period === "current") completed += 1;
    if (period === "comparison") previousCompleted += 1;
  }
  const due = (dueRows as any[]).length;
  const completedDue = (dueRows as any[]).filter(
    (task) => task.status === STAFF_TASK_STATUS.DONE,
  ).length;
  return {
    asOf: now.toISOString(),
    completed,
    previousCompleted: periods.comparison ? previousCompleted : null,
    changePercent: periods.comparison
      ? changePercent(completed, previousCompleted)
      : null,
    open: openCount,
    overdue: overdueCount,
    completionRatePercent: due > 0 ? round((completedDue / due) * 100) : null,
    limitations: scope.requestedLocationId
      ? [
          "Tasks applying to all locations are included in each location report and must not be summed across location exports.",
          "Open and overdue tasks are point-in-time snapshots at asOf.",
        ]
      : ["Open and overdue tasks are point-in-time snapshots at asOf."],
  };
};

export const resolveReportLocale = (
  requestedLocale?: string,
  preferredLocale?: string,
  defaultLocale?: string,
): string => {
  const locale = String(
    requestedLocale || preferredLocale || defaultLocale || "en",
  ).toLowerCase();
  return locale.startsWith("cz") ? "cs" : locale;
};

export const deterministicInsights = ({
  summary,
  coverage,
  locale,
}: {
  summary: Record<string, ReportKpi>;
  coverage: ReportCoverage;
  locale: string;
}) => {
  const cs = locale.toLowerCase().startsWith("cs");
  const highlights: string[] = [];
  const attention: string[] = [];
  const recommendations: string[] = [];
  const sales = summary.netSales;
  const bookings = summary.bookings;
  const utilization = summary.utilizationPercent;
  if (sales.value !== null && sales.changePercent !== null) {
    highlights.push(
      cs
        ? `Přijaté platby po evidovaných vratkách se oproti předchozímu období změnily o ${sales.changePercent} %.`
        : `Cash received after recorded refunds changed by ${sales.changePercent}% versus the previous period.`,
    );
  }
  if (bookings.value !== null && bookings.changePercent !== null) {
    highlights.push(
      cs
        ? `Počet rezervací se oproti předchozímu období změnil o ${bookings.changePercent} %.`
        : `Bookings changed by ${bookings.changePercent}% versus the previous period.`,
    );
  }
  if (utilization.value !== null && utilization.value < 30) {
    attention.push(
      cs
        ? `Využití kapacity je ${utilization.value} %.`
        : `Configured-capacity utilization is ${utilization.value}%.`,
    );
    recommendations.push(
      cs
        ? "Zkontrolujte časový přehled a zvažte propagaci méně využitých termínů."
        : "Review the time breakdown and consider promoting lower-utilization slots.",
    );
  }
  if (!coverage.complete || coverage.limitations.length) {
    attention.push(
      cs
        ? "Některé zdroje nebo ukazatele mají omezené pokrytí."
        : "Some sources or metrics have limited coverage.",
    );
  }
  if (!highlights.length) {
    highlights.push(
      cs
        ? "Přehled je založen pouze na dostupných ověřených datech."
        : "This overview uses only available verified data.",
    );
  }
  return { highlights, attention, recommendations };
};

export const buildReportOverview = async ({
  context,
  query,
  now = new Date(),
}: {
  context: ReportContext;
  query: ReportQuery;
  now?: Date;
}) => {
  const tenant = await TenantModel.findById(context.tenantId)
    .select("modules settings plan planVersion")
    .lean();
  if (!tenant) notFound("Workspace not found.");
  const reportEntitlement = getReportPlanEntitlement({
    plan: tenant.plan as TenantPlan,
    planVersion: Number(tenant.planVersion ?? 1),
  });
  const timezone = String(tenant.settings?.timezone || "UTC");
  const currency = String(tenant.settings?.currency || "CZK").toUpperCase();
  const periods = resolveReportPeriod({ query, timezone, now });
  const scope = await resolveReportLocationScope({
    context,
    locationId: query.locationId,
  });
  if (
    scope.locationIds.length > 1 &&
    !reportEntitlement.consolidatedLocations
  ) {
    forbidden({
      message: "Cross-location reporting is not included in the current plan.",
      code: "CONSOLIDATED_REPORTING_NOT_ENTITLED",
      details: {
        customerSegmentationAvailable:
          !reportEntitlement.courseOnly &&
          reportEntitlement.tier !== "none" &&
          tenant.modules?.customers === true &&
          hasPermission(context, WORKSPACE_PERMISSION.CUSTOMERS_VIEW),
        reportingTier: reportEntitlement.tier,
        currentPlan: tenant.plan,
      },
    });
  }
  const locations = (await LocationModel.find({
    tenant: context.tenantId,
    _id: { $in: scope.locationIds },
  })
    .select("_id isActive booking openingHours")
    .lean()) as any[];
  const coverageBuilder: CoverageBuilder = {
    available: new Set(),
    unavailable: [],
    limitations: new Set(),
  };
  const productsAllowed = hasPermission(
    context,
    WORKSPACE_PERMISSION.PRODUCTS_VIEW,
  );
  const coursesAllowed = sourceAvailability({
    coverage: coverageBuilder,
    source: "courses",
    moduleEnabled:
      tenant.modules?.[TENANT_MODULE.COURSES] === true &&
      tenant.modules?.[TENANT_MODULE.BOOKINGS] === true,
    permissions: [
      hasPermission(context, WORKSPACE_PERMISSION.COURSES_VIEW),
      hasPermission(context, WORKSPACE_PERMISSION.BOOKINGS_VIEW),
      productsAllowed,
    ],
  });

  const [sales, bookings] = await Promise.all([
    buildSales({
      context,
      tenant,
      scope,
      periods,
      timezone,
      currency,
      coverage: coverageBuilder,
      productsAllowed,
      courseOnly: reportEntitlement.courseOnly,
      now,
    }),
    buildBookings({
      context,
      tenant,
      scope,
      periods,
      timezone,
      locations,
      coverage: coverageBuilder,
      coursesAllowed,
      courseOnly: reportEntitlement.courseOnly,
    }),
  ]);
  const customers = await buildCustomers({
    context,
    tenant,
    scope,
    periods,
    coverage: coverageBuilder,
    sales,
    courseOnly: reportEntitlement.courseOnly,
  });
  let inventory = null;
  let staffTasks = null;
  if (reportEntitlement.studioOperations) {
    [inventory, staffTasks] = await Promise.all([
      buildInventory({
        context,
        tenant,
        scope,
        periods,
        currency,
        coverage: coverageBuilder,
        now,
      }),
      buildStaffTasks({
        context,
        tenant,
        scope,
        periods,
        coverage: coverageBuilder,
        now,
      }),
    ]);
  } else {
    for (const source of ["inventory", "staffTasks"]) {
      coverageBuilder.unavailable.push({ source, reason: "plan_tier" });
    }
  }

  const summary = {
    netSales: sales.report
      ? kpi(
          sales.primaryCurrentNetSalesMinor,
          sales.primaryComparisonNetSalesMinor,
        )
      : kpi(null, null),
    bookings: bookings.current
      ? kpi(bookings.current.total, bookings.comparison?.total ?? null)
      : kpi(null, null),
    participants: bookings.current
      ? kpi(
          bookings.current.participants,
          bookings.comparison?.participants ?? null,
        )
      : kpi(null, null),
    utilizationPercent: bookings.current
      ? kpi(
          bookings.current.utilizationPercent,
          bookings.comparison?.utilizationPercent ?? null,
        )
      : kpi(null, null),
    returningCustomerPercent: customers.current
      ? kpi(
          customers.current.returningRatePercent,
          customers.comparison?.returningRatePercent ?? null,
        )
      : kpi(null, null),
  };

  const timeSeries = buildReportBuckets({
    period: periods.current,
    timezone,
    granularity: periods.granularity,
  }).map((bucket) => ({
    periodStart: bucket.periodStart,
    periodEnd: bucket.periodEnd,
    netSalesMinor: sales.report
      ? reportSeriesValue(sales.series, bucket.key)
      : null,
    bookings: bookings.report
      ? (bookings.series.get(bucket.key)?.bookings ?? 0)
      : null,
    participants: bookings.report
      ? (bookings.series.get(bucket.key)?.participants ?? 0)
      : null,
    utilizationPercent: bookings.report
      ? (bookings.seriesUtilization.get(bucket.key) ?? null)
      : null,
  }));
  const meaningfulUnavailable = coverageBuilder.unavailable.filter(
    (entry) =>
      entry.reason !== "module_disabled" && entry.reason !== "plan_tier",
  );
  const coverage: ReportCoverage = {
    available: [...coverageBuilder.available].sort(),
    unavailable: [...coverageBuilder.unavailable].sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.reason.localeCompare(b.reason),
    ),
    limitations: [...coverageBuilder.limitations].sort(),
    complete:
      meaningfulUnavailable.length === 0 &&
      coverageBuilder.limitations.size === 0,
  };
  const locale = resolveReportLocale(
    query.locale,
    context.access.preferences.language,
    tenant.settings?.defaultLanguage,
  );
  return {
    metadata: {
      timezone,
      currency,
      period: {
        from: periods.current.from,
        to: periods.current.to,
      },
      comparisonPeriod: periods.comparison
        ? {
            from: periods.comparison.from,
            to: periods.comparison.to,
          }
        : null,
      granularity: periods.granularity,
      generatedAt: now.toISOString(),
      moneyBasis: "recorded_cash_after_refunds",
      refundBasis: "current_recorded_state",
      cashAsOf: now.toISOString(),
      moneyBasisExplanation:
        "Cash paid in the selected payment-date period, less successful external refunds recorded at calculation time; later refunds revise the original payment month. Not profit or tax-exclusive revenue.",
      locationId: scope.requestedLocationId,
      locale,
      customerSegmentationAvailable:
        !reportEntitlement.courseOnly &&
        reportEntitlement.tier !== "none" &&
        tenant.modules?.customers === true &&
        hasPermission(context, WORKSPACE_PERMISSION.CUSTOMERS_VIEW),
      reportingTier: reportEntitlement.tier,
      consolidatedLocations: reportEntitlement.consolidatedLocations,
    },
    coverage,
    summary,
    timeSeries,
    sales: sales.report,
    bookings: bookings.report,
    customers: customers.report,
    operations: {
      inventory,
      staffTasks,
    },
    insights: deterministicInsights({ summary, coverage, locale }),
  };
};

export const reportService = {
  overview: buildReportOverview,
};
