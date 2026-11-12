import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { badRequest } from "@/shared/http/httpErrors.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);
dayjs.extend(customParseFormat);

const localDate = (dateKey: string, timezone: string) => {
  let value;
  try {
    value = dayjs.tz(dateKey, "YYYY-MM-DD", timezone);
  } catch {
    badRequest({
      message: "The workspace timezone is invalid.",
      code: "STAFF_PLANNING_TIMEZONE_INVALID",
    });
  }
  if (!value.isValid() || value.format("YYYY-MM-DD") !== dateKey) {
    badRequest({
      message: "Invalid planning date.",
      code: "STAFF_PLANNING_DATE_INVALID",
      details: { date: dateKey },
    });
  }
  return value.startOf("day");
};

export const planningToday = (
  timezone: string,
  now = new Date(),
): string => {
  try {
    const value = dayjs(now).tz(timezone);
    if (!value.isValid()) throw new Error("Invalid timezone");
    return value.format("YYYY-MM-DD");
  } catch {
    badRequest({
      message: "The workspace timezone is invalid.",
      code: "STAFF_PLANNING_TIMEZONE_INVALID",
    });
  }
};

export const resolvePlanningDate = (
  dateKey: string | undefined,
  timezone: string,
  now = new Date(),
): string => {
  const resolved = dateKey || planningToday(timezone, now);
  return localDate(resolved, timezone).format("YYYY-MM-DD");
};

export const planningDateRange = (dateKey: string, timezone: string) => {
  const date = localDate(dateKey, timezone);
  const mondayOffset = (date.day() + 6) % 7;
  const weekStart = date.subtract(mondayOffset, "day");
  const weekEnd = weekStart.add(6, "day");
  const monthStart = date.startOf("month");
  const monthEnd = date.endOf("month");
  return {
    date: date.format("YYYY-MM-DD"),
    isoWeekday: ((date.day() + 6) % 7) + 1,
    week: {
      from: weekStart.format("YYYY-MM-DD"),
      to: weekEnd.format("YYYY-MM-DD"),
    },
    month: {
      key: monthStart.format("YYYY-MM"),
      from: monthStart.format("YYYY-MM-DD"),
      to: monthEnd.format("YYYY-MM-DD"),
    },
  };
};

export const assertMondayKey = (
  weekStartKey: string,
  timezone: string,
): string => {
  const range = planningDateRange(weekStartKey, timezone);
  if (range.week.from !== weekStartKey) {
    badRequest({
      message: "Weekly plans must use a Monday date.",
      code: "STAFF_PLANNING_WEEK_START_INVALID",
      details: { expected: range.week.from },
    });
  }
  return weekStartKey;
};

export const assertMonthKey = (
  monthKey: string,
  timezone: string,
): string => {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    badRequest({
      message: "Invalid planning month.",
      code: "STAFF_PLANNING_MONTH_INVALID",
    });
  }
  const dateKey = `${monthKey}-01`;
  localDate(dateKey, timezone);
  return monthKey;
};

