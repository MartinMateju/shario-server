type BusinessInterval = {
  enabled?: boolean;
  open?: string;
  close?: string;
};

export type BusinessHours = {
  timezone?: string;
  monday?: BusinessInterval;
  tuesday?: BusinessInterval;
  wednesday?: BusinessInterval;
  thursday?: BusinessInterval;
  friday?: BusinessInterval;
  saturday?: BusinessInterval;
  sunday?: BusinessInterval;
  holidays?: readonly string[];
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const timeToMinutes = (value = "00:00"): number => {
  const [hours, minutes] = value.split(":").map(Number);
  return Math.max(0, Math.min(1439, hours * 60 + minutes));
};

const localParts = (date: Date, timezone: string) => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(date);
  } catch {
    return localParts(date, "UTC");
  }
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdayLookup: Record<string, (typeof WEEKDAYS)[number]> = {
    Sun: "sunday",
    Mon: "monday",
    Tue: "tuesday",
    Wed: "wednesday",
    Thu: "thursday",
    Fri: "friday",
    Sat: "saturday",
  };
  const localDate = `${value("year")}-${value("month")}-${value("day")}`;
  const localTime = `${value("hour")}:${value("minute")}`;
  return {
    localDate,
    localTime,
    weekday: weekdayLookup[value("weekday")] ?? "monday",
    minutes: timeToMinutes(localTime),
  };
};

export const evaluateBusinessHours = (
  date: Date,
  hours: BusinessHours,
): {
  isOpen: boolean;
  reason: "open" | "closed_day" | "outside_hours" | "holiday";
  localDate: string;
  localTime: string;
  timezone: string;
} => {
  const timezone = hours.timezone || "UTC";
  const local = localParts(date, timezone);

  if ((hours.holidays ?? []).includes(local.localDate)) {
    return { isOpen: false, reason: "holiday", localDate: local.localDate, localTime: local.localTime, timezone };
  }

  // An interval such as Monday 22:00–02:00 remains open during the first
  // two hours of Tuesday, even when Tuesday has no interval of its own.
  const currentWeekdayIndex = WEEKDAYS.indexOf(local.weekday);
  const previousWeekday = WEEKDAYS[(currentWeekdayIndex + 6) % 7];
  const previousInterval = hours[previousWeekday];
  if (previousInterval?.enabled) {
    const previousOpen = timeToMinutes(previousInterval.open || "09:00");
    const previousClose = timeToMinutes(previousInterval.close || "17:00");
    if (previousOpen > previousClose && local.minutes < previousClose) {
      return {
        isOpen: true,
        reason: "open",
        localDate: local.localDate,
        localTime: local.localTime,
        timezone,
      };
    }
  }

  const interval = hours[local.weekday];
  if (!interval?.enabled) {
    return { isOpen: false, reason: "closed_day", localDate: local.localDate, localTime: local.localTime, timezone };
  }

  const open = timeToMinutes(interval.open || "09:00");
  const close = timeToMinutes(interval.close || "17:00");
  const isOpen =
    open === close ||
    (open < close
      ? local.minutes >= open && local.minutes < close
      : local.minutes >= open || local.minutes < close);

  return {
    isOpen,
    reason: isOpen ? "open" : "outside_hours",
    localDate: local.localDate,
    localTime: local.localTime,
    timezone,
  };
};

export const isWithinQuietHours = (
  date: Date,
  quietHours: { enabled?: boolean; start?: string; end?: string },
  timezone = "UTC",
): boolean => {
  if (!quietHours.enabled) return false;
  const minute = localParts(date, timezone).minutes;
  const start = timeToMinutes(quietHours.start || "21:00");
  const end = timeToMinutes(quietHours.end || "08:00");
  if (start === end) return true;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
};

export const shouldSendAbsenceReply = ({
  evaluation,
  enabled,
  lastReplyAt,
  repeatAfterHours = 24,
  now = new Date(),
}: {
  evaluation: { isOpen: boolean };
  enabled: boolean;
  lastReplyAt?: Date | string | null;
  repeatAfterHours?: number;
  now?: Date;
}): boolean => {
  if (!enabled || evaluation.isOpen) return false;
  if (!lastReplyAt) return true;
  return now.getTime() - new Date(lastReplyAt).getTime() >= repeatAfterHours * 3_600_000;
};
