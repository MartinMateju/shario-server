import dayjs from "dayjs";

import {
  DATE_FORMAT,
  parseDateStringInTimezone,
  parseTimeString,
  type BookingRange,
} from "@/shared/time/time.utils.js";

type OpeningHoursDay = {
  isOpen?: unknown;
  openTime?: unknown;
  closeTime?: unknown;
};
type OpeningHours = Record<string, OpeningHoursDay | undefined>;

/** A weekday describes an opening interval, which may finish the next day. */
export const buildLocationOpeningWindow = ({
  date,
  hours,
  timezone,
}: {
  date: string;
  hours: OpeningHoursDay | null | undefined;
  timezone: string;
}): BookingRange | null => {
  if (!hours?.isOpen) return null;
  const day = parseDateStringInTimezone(date, timezone);
  const open = parseTimeString(String(hours.openTime || "06:00"));
  const closeText = String(hours.closeTime || "24:00");
  const close = parseTimeString(closeText === "24:00" ? "00:00" : closeText);
  if (!day || !open || !close) return null;
  const nextDay =
    close.hour * 60 + close.minute <= open.hour * 60 + open.minute;
  const endDate = nextDay ? day.add(1, "day").format(DATE_FORMAT) : date;
  const localTime = (value: { hour: number; minute: number }) =>
    `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
  // Parse each endpoint in its own local calendar date. Adding 24 elapsed
  // hours or changing the hour on zoned midnight retains the wrong DST offset.
  return {
    start: dayjs
      .tz(`${date} ${localTime(open)}`, "YYYY-MM-DD HH:mm", timezone)
      .toDate(),
    end: dayjs
      .tz(`${endDate} ${localTime(close)}`, "YYYY-MM-DD HH:mm", timezone)
      .toDate(),
  };
};

/** Find a single continuous opening interval containing the entire booking. */
export const findLocationOpeningWindow = ({
  start,
  end,
  openingHours,
  timezone,
}: {
  start: Date;
  end: Date;
  openingHours?: OpeningHours;
  timezone: string;
}): BookingRange | null => {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start
  )
    return null;
  const localDay = dayjs(start).tz(timezone);
  // A closed current weekday does not cancel the previous day's overnight
  // interval. Conversely a closed previous weekday contributes no carryover.
  for (const day of [localDay, localDay.subtract(1, "day")]) {
    const range = buildLocationOpeningWindow({
      date: day.format(DATE_FORMAT),
      hours: openingHours?.[day.format("dddd").toLowerCase()],
      timezone,
    });
    if (range && start >= range.start && end <= range.end) return range;
  }
  return null;
};
