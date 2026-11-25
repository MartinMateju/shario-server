import dayjs from "dayjs";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { activeBookingParticipants } from "@/modules/booking/booking.attendance-read.js";
import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import {
  addTenantCalendarDays,
  resolveReportPeriod,
} from "@/modules/reports/reports.date.js";
import type {
  ReportKpi,
  ReportPeriod,
} from "@/modules/reports/reports.types.js";
import type {
  ManagementClient,
  ManagementProduct,
} from "./dashboard-management.types.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

export const managementId = (value: any): string =>
  String(value?._id ?? value ?? "").trim();
export const managementDate = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
};
export const managementNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
export const managementKpi = (
  value: number | null,
  previous: number | null,
): ReportKpi => ({
  value,
  previous,
  changePercent:
    value === null || previous === null || (previous === 0 && value !== 0)
      ? null
      : previous === 0
        ? 0
        : Math.round(((value - previous) / Math.abs(previous)) * 10000) / 100,
});
export const inManagementPeriod = (
  value: unknown,
  period: ReportPeriod,
): boolean => {
  const date = managementDate(value);
  return Boolean(date && date >= period.start && date < period.endExclusive);
};

export const resolveManagementPeriods = (
  date: string | undefined,
  timezone: string,
  now = new Date(),
) => {
  // Reuse the report validator before deriving any calendar bounds.
  const selected = resolveReportPeriod({
    query: { from: date, to: date, compare: false, granularity: "day" },
    timezone,
    now,
  }).current;
  const today = dayjs(now).tz(timezone).format("YYYY-MM-DD");
  const to = selected.to > today ? today : selected.to;
  const local = dayjs.tz(to, timezone);
  const previousMonth = local.subtract(1, "month");
  const previousTo = previousMonth
    .date(Math.min(local.date(), previousMonth.daysInMonth()))
    .format("YYYY-MM-DD");
  const period = (from: string, end: string): ReportPeriod => {
    const resolved = resolveReportPeriod({
      query: { from, to: end, compare: false, granularity: "day" },
      timezone,
      now,
    }).current;
    // Calendar-day stepping re-resolves the UTC offset across DST changes.
    resolved.endExclusive = addTenantCalendarDays(
      dayjs.tz(end, timezone).toDate(),
      1,
      timezone,
    );
    return resolved;
  };
  const current = period(local.startOf("month").format("YYYY-MM-DD"), to);
  const comparison = period(
    previousMonth.startOf("month").format("YYYY-MM-DD"),
    previousTo,
  );
  const arrivals = period(local.subtract(29, "day").format("YYYY-MM-DD"), to);
  const comparisonLocal = dayjs.tz(previousTo, timezone);
  const activeCustomerComparison = period(
    comparisonLocal.subtract(29, "day").format("YYYY-MM-DD"),
    previousTo,
  );
  return {
    current,
    comparison,
    arrivals,
    activeCustomerComparison,
    asOf: new Date(Math.min(now.getTime(), current.endExclusive.getTime())),
  };
};

export const scheduledBookingEligible = (booking: any, asOf: Date): boolean => {
  const end = managementDate(booking.end);
  const tags: readonly string[] = [
    ...CLASS_BOOKING_TAGS,
    ...OPEN_STUDIO_BOOKING_TAGS,
  ];
  return Boolean(
    tags.includes(booking.tag) &&
    booking.status !== BOOKING_STATUS.CANCELLED &&
    booking.paymentStatus === PAYMENT_STATUS.CONFIRMED &&
    end &&
    end <= asOf,
  );
};

export const managementParticipantCount = (booking: any): number => {
  const participants = activeBookingParticipants(booking).length;
  if (booking.attendanceManaged === true) return participants;
  const guests = Math.max(managementNumber(booking.numberOfGuests) ?? 0, 0);
  return Math.max(
    participants,
    guests,
    (OPEN_STUDIO_BOOKING_TAGS as readonly string[]).includes(booking.tag)
      ? 1
      : 0,
  );
};

export const managementBookingCustomers = (
  booking: any,
): Array<{ id: string; name: string }> => {
  const customers = new Map<string, string>();
  for (const participant of activeBookingParticipants(booking)) {
    const id = managementId(participant.customer);
    if (id)
      customers.set(
        id,
        participant.name ||
          [participant.firstname, participant.lastname]
            .filter(Boolean)
            .join(" ") ||
          "",
      );
  }
  // A class's creator is its instructor, not a participant. Open-studio
  // bookings are customer-owned; keep anonymous guests out of unique counts.
  if (
    (OPEN_STUDIO_BOOKING_TAGS as readonly string[]).includes(booking.tag) &&
    !booking.attendanceManaged
  ) {
    const id = managementId(booking.createdBy);
    if (id && !customers.has(id)) customers.set(id, booking.author?.name || "");
  }
  return [...customers].map(([id, name]) => ({ id, name }));
};

/** Deliberately isolated: legacy DELIVERED is an automatic start+1h flag. */
export const hasConfirmedServiceCompletion = (
  booking: any,
  asOf: Date,
): boolean => {
  const end = managementDate(booking.end);
  const serviceTags: readonly string[] = [
    ...CLASS_BOOKING_TAGS,
    ...OPEN_STUDIO_BOOKING_TAGS,
  ];
  // Delivery and payment are independent: an unpaid completed service can
  // recognize revenue, while advance payment alone cannot.
  return Boolean(
    booking.status === BOOKING_STATUS.COMPLETED &&
    serviceTags.includes(booking.tag) &&
    end &&
    end <= asOf,
  );
};

export const calculateConfirmedServiceRevenue = ({
  orders,
  bookings,
  current,
  comparison,
  asOf,
  currency,
  locationIds,
}: {
  orders: any[];
  bookings: any[];
  current: ReportPeriod;
  comparison: ReportPeriod;
  asOf: Date;
  currency: string;
  locationIds: string[];
}) => {
  const completed = new Map(
    bookings
      .filter((b) => hasConfirmedServiceCompletion(b, asOf))
      .map((b) => [managementId(b._id), b]),
  );
  const totals = { current: 0, comparison: 0 };
  const clients = new Map<string, ManagementClient>();
  const products = new Map<string, ManagementProduct>();
  let excludedLines = 0;
  for (const order of orders) {
    if (
      String(order.currency).toUpperCase() !== currency ||
      order.status === "cancelled_order" ||
      order.status === "failed_order"
    )
      continue;
    // Credit/membership redemption is already recognised by its source contract;
    // its nominal booking price must not become a second revenue entry.
    if (
      order.membershipRedemption?.membershipId ||
      (order.paymentAllocations || []).some(
        (p: any) => p.method === "membership_credit",
      )
    ) {
      excludedLines += (order.lineItems || []).length;
      continue;
    }
    // Order-level discounts alter the consideration after line snapshots. Until
    // an allocated delivery snapshot exists, exclude rather than overstate them.
    const lines = order.lineItems || [];
    const gross = managementNumber(order.grossAmountMinor);
    const lineGross = lines.reduce(
      (sum: number, line: any) =>
        sum + (managementNumber(line.grossAmountMinor) ?? 0),
      0,
    );
    if (
      (managementNumber(order.appliedDiscount?.amountMinor) ?? 0) > 0 ||
      gross === null ||
      gross !== lineGross
    ) {
      excludedLines += lines.length;
      continue;
    }
    for (const line of lines) {
      const booking = completed.get(managementId(line.booking));
      if (!booking) continue;
      // Revenue follows the completed service's end, never the order/payment date.
      const side = inManagementPeriod(booking.end, current)
        ? "current"
        : inManagementPeriod(booking.end, comparison)
          ? "comparison"
          : null;
      if (!side) continue;
      const locations = (line.locationIds || []).map(managementId);
      const amount = managementNumber(line.netAmountMinor);
      const quantity = managementNumber(line.quantity);
      const lineGrossAmount = managementNumber(line.grossAmountMinor);
      const tax = managementNumber(line.taxAmountMinor);
      const bookingId = managementId(booking._id);
      const hasCorrection =
        (order.courseCancellations || []).some(
          (c: any) => managementId(c.bookingId) === bookingId,
        ) ||
        order.waitlistRefund?.amountMinor ||
        order.pieceCheckout?.refundedAmountMinor;
      if (
        !locations.length ||
        locations.some((id: string) => !locationIds.includes(id)) ||
        amount === null ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        lineGrossAmount === null ||
        tax === null ||
        !Number.isSafeInteger(lineGrossAmount) ||
        !Number.isSafeInteger(tax) ||
        tax < 0 ||
        amount + tax !== lineGrossAmount ||
        quantity === null ||
        quantity <= 0 ||
        hasCorrection
      ) {
        excludedLines++;
        continue;
      }
      totals[side] += amount;
      if (side !== "current") continue;
      const customerId = managementId(order.createdBy);
      if (customerId) {
        const client = clients.get(customerId) || {
          id: customerId,
          name:
            [order.customer?.firstname, order.customer?.lastname]
              .filter(Boolean)
              .join(" ") || "",
          visits: 0,
          revenueMinor: 0,
        };
        client.revenueMinor = (client.revenueMinor ?? 0) + amount;
        clients.set(customerId, client);
      }
      const productId =
        managementId(line.product) || managementId(booking.bookingProduct);
      const key = productId || line.description || bookingId;
      const product = products.get(key) || {
        id: key,
        name: line.description || key,
        quantity: 0,
        revenueMinor: 0,
      };
      product.quantity += quantity;
      product.revenueMinor = (product.revenueMinor ?? 0) + amount;
      products.set(key, product);
    }
  }
  return {
    totals,
    excludedLines,
    clients: [...clients.values()].sort(
      (a, b) => (b.revenueMinor ?? 0) - (a.revenueMinor ?? 0),
    ),
    products: [...products.values()].sort(
      (a, b) =>
        b.quantity - a.quantity ||
        (b.revenueMinor ?? 0) - (a.revenueMinor ?? 0),
    ),
  };
};
