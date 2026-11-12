import dayjs, { type Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const DEFAULT_TIMEZONE = "Europe/Prague" as const;
export const DATE_FORMAT = "YYYY-MM-DD" as const;
export const TIME_FORMAT = "HH:mm" as const;

export type ParsedTime = {
  hour: number;
  minute: number;
};

export type BookingRangeInput = {
  date: string;
  startTime: string;
  endTime: string;
  timezone?: string;
};

export type BookingRange = {
  start: Date;
  end: Date;
};

export const parseTimeString = (
  value?: string | null,
): ParsedTime | null => {
  const normalized = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
};

export const parseDateStringInTimezone = (
  value?: string | null,
  timezone: string = DEFAULT_TIMEZONE,
): Dayjs | null => {
  const normalized = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  const parsed = dayjs.tz(normalized, DATE_FORMAT, timezone);

  if (!parsed.isValid()) {
    return null;
  }

  // Prevent invalid dates like 2026-02-31 from rolling over.
  if (parsed.format(DATE_FORMAT) !== normalized) {
    return null;
  }

  return parsed;
};

export const buildUTCDateFromLocalDateAndTime = ({
  date,
  time,
  timezone = DEFAULT_TIMEZONE,
}: {
  date: string;
  time: string;
  timezone?: string;
}): Date | null => {
  const parsedDate = parseDateStringInTimezone(date, timezone);
  const parsedTime = parseTimeString(time);

  if (!parsedDate || !parsedTime) {
    return null;
  }

  return parsedDate
    .hour(parsedTime.hour)
    .minute(parsedTime.minute)
    .second(0)
    .millisecond(0)
    .utc()
    .toDate();
};

export const buildUTCBookingRangeFromLocalInputs = ({
  date,
  startTime,
  endTime,
  timezone = DEFAULT_TIMEZONE,
}: BookingRangeInput): BookingRange | null => {
  const start = buildUTCDateFromLocalDateAndTime({
    date,
    time: startTime,
    timezone,
  });

  let end = buildUTCDateFromLocalDateAndTime({
    date,
    time: endTime,
    timezone,
  });

  if (!start || !end) {
    return null;
  }

  // Allows ranges crossing midnight, e.g. 23:00 -> 01:00.
  if (end.getTime() <= start.getTime()) {
    end = dayjs(end).add(1, "day").toDate();
  }

  return {
    start,
    end,
  };
};

export const convertTimeToNumber = (time: unknown): number => {
  if (typeof time !== "string") return Number.NaN;
  const [h, m] = time.split(":");
  const hours = Number(h);
  const minutes = Number(m);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return Number.NaN;
  return hours + minutes / 60;
};

export const getFormattedTime = (time: string | number | Date): string => {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
};

export const parsePragueDateString = (value?: string | null): Dayjs | null => {
  return parseDateStringInTimezone(value, DEFAULT_TIMEZONE);
};

export const buildUTCBookingRangeFromPragueInputs = ({
  date,
  startTime,
  endTime,
}: Omit<BookingRangeInput, "timezone">): BookingRange | null => {
  return buildUTCBookingRangeFromLocalInputs({
    date,
    startTime,
    endTime,
    timezone: DEFAULT_TIMEZONE,
  });
};