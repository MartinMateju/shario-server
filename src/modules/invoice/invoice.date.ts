import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);
dayjs.extend(customParseFormat);

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_DATE_FORMAT = "YYYY-MM-DD";

export type InvoiceDateInput = Date | string;

export type InvoiceIssueDateRange = {
  $gte?: Date;
  $lte?: Date;
  $lt?: Date;
};

export const isInvoiceCalendarDate = (
  value: unknown,
): value is string => {
  if (typeof value !== "string" || !CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const assertIanaTimezone = (timezone: string): void => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new RangeError(`Invalid tenant timezone: ${timezone}`);
  }
};

export const invoiceCalendarDateToInstant = (
  value: string,
  timezone: string,
): Date => {
  if (!isInvoiceCalendarDate(value)) {
    throw new RangeError(`Invalid invoice calendar date: ${value}`);
  }

  assertIanaTimezone(timezone);
  const parsed = dayjs.tz(value, CALENDAR_DATE_FORMAT, timezone).startOf("day");

  if (!parsed.isValid() || parsed.format(CALENDAR_DATE_FORMAT) !== value) {
    throw new RangeError(`Invalid invoice calendar date: ${value}`);
  }

  return parsed.toDate();
};

/**
 * Converts an API date input into the stored instant. Bare calendar dates are
 * interpreted at the start of that day in the tenant timezone; datetimes keep
 * their exact instant for backwards compatibility.
 */
export const resolveInvoiceDateInput = (
  value: InvoiceDateInput | null | undefined,
  timezone: string,
): Date | null | undefined => {
  if (value === null) return null;
  if (value === undefined) return undefined;

  if (isInvoiceCalendarDate(value)) {
    return invoiceCalendarDateToInstant(value, timezone);
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError("Invalid invoice date.");
  }

  return parsed;
};

const calendarDateForInstant = (value: Date, timezone: string): string => {
  assertIanaTimezone(timezone);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
};

/** Adds whole calendar days in the tenant timezone (safe across DST). */
export const addInvoiceCalendarDays = (
  value: Date,
  days: number,
  timezone: string,
): Date => {
  const calendarDate = calendarDateForInstant(value, timezone);
  const start = invoiceCalendarDateToInstant(calendarDate, timezone);

  return dayjs(start).tz(timezone).add(Math.max(0, days), "day").startOf("day").toDate();
};

/**
 * Builds Mongo boundaries for invoice issue-date filters. A date-only upper
 * boundary is exclusive start-of-next-day, so DST-short and DST-long days are
 * included exactly once. Datetime inputs remain exact inclusive instants.
 */
export const buildInvoiceIssueDateRange = ({
  dateFrom,
  dateTo,
  timezone,
}: {
  dateFrom?: InvoiceDateInput;
  dateTo?: InvoiceDateInput;
  timezone: string;
}): InvoiceIssueDateRange => {
  const range: InvoiceIssueDateRange = {};

  if (dateFrom !== undefined) {
    range.$gte = resolveInvoiceDateInput(dateFrom, timezone) as Date;
  }

  if (dateTo !== undefined) {
    if (isInvoiceCalendarDate(dateTo)) {
      range.$lt = addInvoiceCalendarDays(
        invoiceCalendarDateToInstant(dateTo, timezone),
        1,
        timezone,
      );
    } else {
      range.$lte = resolveInvoiceDateInput(dateTo, timezone) as Date;
    }
  }

  return range;
};
