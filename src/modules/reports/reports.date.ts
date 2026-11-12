import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { badRequest } from "@/shared/http/httpErrors.js";

import {
  REPORT_GRANULARITY,
  type ReportPeriod,
  type ReportQuery,
  type ResolvedReportGranularity,
  type ResolvedReportPeriod,
} from "./reports.types.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);
dayjs.extend(customParseFormat);

export const MAX_REPORT_DAYS = 366;
export const DEFAULT_REPORT_DAYS = 30;

const parseCalendarDate = (value: string, timezone: string) => {
  const parsed = dayjs.tz(value, "YYYY-MM-DD", timezone);
  if (!parsed.isValid() || parsed.format("YYYY-MM-DD") !== value) {
    badRequest({
      message: "Invalid report date.",
      code: "REPORT_DATE_INVALID",
      details: { value },
    });
  }
  return parsed.startOf("day");
};

export const addTenantCalendarDays = (
  value: Date,
  days: number,
  timezone: string,
): Date =>
  parseCalendarDate(
    dayjs(value).tz(timezone).add(days, "day").format("YYYY-MM-DD"),
    timezone,
  ).toDate();

const periodFromBounds = (
  from: string,
  to: string,
  timezone: string,
): ReportPeriod => {
  const start = parseCalendarDate(from, timezone);
  const end = parseCalendarDate(to, timezone);
  if (end.isBefore(start, "day")) {
    badRequest({
      message: "Report end date must not be before its start date.",
      code: "REPORT_DATE_RANGE_INVALID",
    });
  }
  const days = end.diff(start, "day") + 1;
  if (days > MAX_REPORT_DAYS) {
    badRequest({
      message: `Reports are limited to ${MAX_REPORT_DAYS} days.`,
      code: "REPORT_DATE_RANGE_TOO_LARGE",
      details: { maxDays: MAX_REPORT_DAYS },
    });
  }
  return {
    from: start.format("YYYY-MM-DD"),
    to: end.format("YYYY-MM-DD"),
    start: start.toDate(),
    endExclusive: end.add(1, "day").startOf("day").toDate(),
    days,
  };
};

export const resolveReportGranularity = (
  requested: ReportQuery["granularity"],
  days: number,
): ResolvedReportGranularity => {
  if (requested !== REPORT_GRANULARITY.AUTO) return requested;
  if (days <= 45) return REPORT_GRANULARITY.DAY;
  if (days <= 180) return REPORT_GRANULARITY.WEEK;
  return REPORT_GRANULARITY.MONTH;
};

export const resolveReportPeriod = ({
  query,
  timezone,
  now = new Date(),
}: {
  query: ReportQuery;
  timezone: string;
  now?: Date;
}): ResolvedReportPeriod => {
  let localToday;
  try {
    localToday = dayjs(now).tz(timezone).startOf("day");
    if (!localToday.isValid()) throw new Error("Invalid timezone.");
  } catch {
    badRequest({
      message: "The workspace timezone is invalid.",
      code: "REPORT_TIMEZONE_INVALID",
    });
  }

  const to = query.to ?? localToday.format("YYYY-MM-DD");
  const toDate = parseCalendarDate(to, timezone);
  const from =
    query.from ??
    toDate
      .subtract(DEFAULT_REPORT_DAYS - 1, "day")
      .format("YYYY-MM-DD");
  const current = periodFromBounds(from, to, timezone);
  const comparison = query.compare
    ? periodFromBounds(
        dayjs(current.start)
          .tz(timezone)
          .subtract(current.days, "day")
          .format("YYYY-MM-DD"),
        dayjs(current.start)
          .tz(timezone)
          .subtract(1, "day")
          .format("YYYY-MM-DD"),
        timezone,
      )
    : null;

  return {
    current,
    comparison,
    queryStart: comparison?.start ?? current.start,
    queryEndExclusive: current.endExclusive,
    granularity: resolveReportGranularity(query.granularity, current.days),
  };
};

export const calendarDateInTimezone = (
  value: Date,
  timezone: string,
): string => dayjs(value).tz(timezone).format("YYYY-MM-DD");

export const reportBucketFor = ({
  value,
  timezone,
  granularity,
}: {
  value: Date;
  timezone: string;
  granularity: ResolvedReportGranularity;
}): string => {
  const local = dayjs(value).tz(timezone);
  if (granularity === REPORT_GRANULARITY.MONTH) {
    return local.startOf("month").format("YYYY-MM-DD");
  }
  if (granularity === REPORT_GRANULARITY.WEEK) {
    const mondayOffset = (local.day() + 6) % 7;
    return local.subtract(mondayOffset, "day").startOf("day").format("YYYY-MM-DD");
  }
  return local.format("YYYY-MM-DD");
};

export const buildReportBuckets = ({
  period,
  timezone,
  granularity,
}: {
  period: ReportPeriod;
  timezone: string;
  granularity: ResolvedReportGranularity;
}): Array<{ key: string; periodStart: string; periodEnd: string }> => {
  const buckets = new Map<
    string,
    { key: string; periodStart: string; periodEnd: string }
  >();
  let cursor = dayjs(period.start).tz(timezone).startOf("day");
  const end = dayjs(period.endExclusive).tz(timezone);
  while (cursor.isBefore(end)) {
    const key = reportBucketFor({
      value: cursor.toDate(),
      timezone,
      granularity,
    });
    const existing = buckets.get(key);
    const date = cursor.format("YYYY-MM-DD");
    if (existing) existing.periodEnd = date;
    else buckets.set(key, { key, periodStart: date, periodEnd: date });
    cursor = dayjs(addTenantCalendarDays(cursor.toDate(), 1, timezone)).tz(
      timezone,
    );
  }
  return [...buckets.values()];
};

export const isInReportPeriod = (
  value: Date | null | undefined,
  period: ReportPeriod | null,
): boolean =>
  Boolean(
    value &&
      period &&
      value >= period.start &&
      value < period.endExclusive,
  );
