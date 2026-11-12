import dayjs from "dayjs";
import { activeBookingParticipants } from "@/modules/booking/booking.attendance-read.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import Booking from "@/modules/booking/booking.model.js";
import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

export const COURSE_CAPACITY_ADVISOR_LOOKBACK_DAYS = 56;
export const COURSE_CAPACITY_ADVISOR_MIN_SESSIONS = 3;
export const COURSE_CAPACITY_ADVISOR_MIN_FILL_PERCENT = 90;
const COURSE_CAPACITY_ADVISOR_EVIDENCE_LIMIT = 8;

const WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const finiteNonNegative = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const entityId = (value: unknown): string =>
  String(
    value && typeof value === "object" && "_id" in value
      ? (value as { _id?: unknown })._id
      : (value ?? ""),
  ).trim();

const localizedProductName = (value: unknown): string => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const localized = value as Record<string, unknown>;
    for (const key of ["CZ", "EN", "cs", "en"]) {
      const candidate = localized[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  return "Course";
};

const round = (value: number, digits = 1): number => {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const seatsFor = (booking: any): number =>
  Math.max(
    activeBookingParticipants(booking).length,
    finiteNonNegative(booking?.numberOfGuests),
  );

export type CourseCapacityAdvisorPeriod = {
  key: "recent_56_tenant_calendar_days";
  from: string;
  to: string;
  days: number;
  timezone: string;
  asOf: string;
};

export type CourseCapacityAdvisorSignal = {
  key: "repeatedCourseSaturation";
  value: number;
  productId: string;
  courseName: string;
  weekday: number;
  weekdayKey: (typeof WEEKDAY_KEYS)[number];
  localStartTime: string;
  sessionCount: number;
  highFillSessionCount: number;
  averageFillPercent: number;
  totalBookedSeats: number;
  totalCapacity: number;
  threshold: {
    minimumHighFillSessions: number;
    minimumAverageFillPercent: number;
  };
  period: CourseCapacityAdvisorPeriod;
  capacityBasis: "current_product_capacity";
  recommendation: {
    kind: "review_or_increase_capacity";
    automaticChange: false;
  };
  evidence: {
    total: number;
    items: Array<{
      sessionId: string;
      start: string;
      end: string;
      bookedSeats: number;
      capacity: number;
      fillPercent: number;
    }>;
    truncated: boolean;
  };
};

type CapacitySlot = {
  productId: string;
  courseName: string;
  weekday: number;
  weekdayKey: (typeof WEEKDAY_KEYS)[number];
  localStartTime: string;
  sessions: CourseCapacityAdvisorSignal["evidence"]["items"];
};

export const buildCourseCapacityAdvisorPeriod = ({
  timezone,
  now,
}: {
  timezone: string;
  now: Date;
}): CourseCapacityAdvisorPeriod => {
  const localNow = dayjs(now).tz(timezone);
  const from = localNow
    .startOf("day")
    .subtract(COURSE_CAPACITY_ADVISOR_LOOKBACK_DAYS - 1, "day");

  return {
    key: "recent_56_tenant_calendar_days",
    from: from.format("YYYY-MM-DD"),
    to: localNow.format("YYYY-MM-DD"),
    days: COURSE_CAPACITY_ADVISOR_LOOKBACK_DAYS,
    timezone,
    asOf: now.toISOString(),
  };
};

export const analyzeRepeatedCourseSaturation = ({
  rows,
  period,
}: {
  rows: any[];
  period: CourseCapacityAdvisorPeriod;
}): CourseCapacityAdvisorSignal | null => {
  const slots = new Map<string, CapacitySlot>();

  for (const row of rows) {
    const product =
      row?.bookingProduct && typeof row.bookingProduct === "object"
        ? row.bookingProduct
        : null;
    if (!product || !COURSE_PRODUCT_TYPES.includes(product.type as never)) {
      continue;
    }

    const productId = entityId(product);
    const sessionId = entityId(row?._id);
    const start =
      row?.start instanceof Date
        ? row.start
        : new Date(String(row?.start || ""));
    const end =
      row?.end instanceof Date ? row.end : new Date(String(row?.end || ""));
    const capacity = finiteNonNegative(product.maxNumberOfParticipants);
    if (
      !productId ||
      !sessionId ||
      Number.isNaN(start.valueOf()) ||
      Number.isNaN(end.valueOf()) ||
      capacity <= 0
    ) {
      continue;
    }

    const local = dayjs(start).tz(period.timezone);
    const weekday = (local.day() + 6) % 7;
    const localStartTime = local.format("HH:mm");
    const slotKey = `${productId}:${weekday}:${localStartTime}`;
    const slot = slots.get(slotKey) ?? {
      productId,
      courseName: localizedProductName(product.name),
      weekday,
      weekdayKey: WEEKDAY_KEYS[weekday],
      localStartTime,
      sessions: [],
    };
    const bookedSeats = seatsFor(row);
    slot.sessions.push({
      sessionId,
      start: start.toISOString(),
      end: end.toISOString(),
      bookedSeats,
      capacity,
      fillPercent: round((bookedSeats / capacity) * 100),
    });
    slots.set(slotKey, slot);
  }

  const candidates = [...slots.values()]
    .map((slot) => {
      const totalBookedSeats = slot.sessions.reduce(
        (sum, session) => sum + session.bookedSeats,
        0,
      );
      const totalCapacity = slot.sessions.reduce(
        (sum, session) => sum + session.capacity,
        0,
      );
      const averageFillPercent =
        totalCapacity > 0 ? round((totalBookedSeats / totalCapacity) * 100) : 0;
      const highFillSessionCount = slot.sessions.filter(
        (session) =>
          session.fillPercent >= COURSE_CAPACITY_ADVISOR_MIN_FILL_PERCENT,
      ).length;

      return {
        ...slot,
        totalBookedSeats,
        totalCapacity,
        averageFillPercent,
        highFillSessionCount,
      };
    })
    .filter(
      (slot) =>
        slot.highFillSessionCount >= COURSE_CAPACITY_ADVISOR_MIN_SESSIONS &&
        slot.averageFillPercent >= COURSE_CAPACITY_ADVISOR_MIN_FILL_PERCENT,
    )
    .sort(
      (left, right) =>
        right.averageFillPercent - left.averageFillPercent ||
        right.highFillSessionCount - left.highFillSessionCount ||
        right.sessions.length - left.sessions.length ||
        left.courseName.localeCompare(right.courseName) ||
        left.weekday - right.weekday ||
        left.localStartTime.localeCompare(right.localStartTime),
    );

  const winner = candidates[0];
  if (!winner) return null;

  const evidence = [...winner.sessions].sort(
    (left, right) =>
      new Date(right.start).valueOf() - new Date(left.start).valueOf(),
  );

  return {
    key: "repeatedCourseSaturation",
    value: winner.averageFillPercent,
    productId: winner.productId,
    courseName: winner.courseName,
    weekday: winner.weekday,
    weekdayKey: winner.weekdayKey,
    localStartTime: winner.localStartTime,
    sessionCount: winner.sessions.length,
    highFillSessionCount: winner.highFillSessionCount,
    averageFillPercent: winner.averageFillPercent,
    totalBookedSeats: winner.totalBookedSeats,
    totalCapacity: winner.totalCapacity,
    threshold: {
      minimumHighFillSessions: COURSE_CAPACITY_ADVISOR_MIN_SESSIONS,
      minimumAverageFillPercent: COURSE_CAPACITY_ADVISOR_MIN_FILL_PERCENT,
    },
    period,
    capacityBasis: "current_product_capacity",
    recommendation: {
      kind: "review_or_increase_capacity",
      automaticChange: false,
    },
    evidence: {
      total: evidence.length,
      items: evidence.slice(0, COURSE_CAPACITY_ADVISOR_EVIDENCE_LIMIT),
      truncated: evidence.length > COURSE_CAPACITY_ADVISOR_EVIDENCE_LIMIT,
    },
  };
};

export const loadCourseCapacityAdvisor = async ({
  tenantId,
  locationIds,
  timezone,
  now,
}: {
  tenantId: string;
  locationIds: readonly string[];
  timezone: string;
  now: Date;
}): Promise<{
  period: CourseCapacityAdvisorPeriod;
  analyzedSessions: number;
  signal: CourseCapacityAdvisorSignal | null;
}> => {
  const period = buildCourseCapacityAdvisorPeriod({ timezone, now });
  const from = dayjs.tz(period.from, "YYYY-MM-DD", timezone).toDate();
  const rows = await Booking.find({
    tenant: tenantId,
    location: { $in: locationIds },
    start: { $gte: from, $lt: now },
    end: { $lte: now },
    status: { $ne: BOOKING_STATUS.CANCELLED },
    paymentStatus: PAYMENT_STATUS.CONFIRMED,
    tag: { $in: CLASS_BOOKING_TAGS },
  })
    .sort({ start: 1, _id: 1 })
    .select("_id start end location participants numberOfGuests bookingProduct")
    .populate({
      path: "bookingProduct",
      select: "name type maxNumberOfParticipants",
      match: {
        tenant: tenantId,
        type: { $in: [...COURSE_PRODUCT_TYPES] },
      },
    })
    .lean();

  return {
    period,
    analyzedSessions: (rows as any[]).length,
    signal: analyzeRepeatedCourseSaturation({
      rows: rows as any[],
      period,
    }),
  };
};
