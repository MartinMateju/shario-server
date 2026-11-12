import {
  COMMUNICATION_DAY_OF_WEEK,
  COMMUNICATION_SCHEDULE_TYPE,
  type CommunicationScheduleType,
} from "../communication-automation.constants.js";

export type ScheduleInput = {
  scheduleType: CommunicationScheduleType | string;
  sendTime?: string;
  oneTimeSendAt?: Date | string | null;
  dayOfWeek?: string;
  dayOfMonth?: number;
  minutesOffset?: number;
};

export const COMMUNICATION_EVENT_RECOVERY_WINDOW_MS =
  7 * 24 * 60 * 60_000;
export const COMMUNICATION_EVENT_SCAN_OVERLAP_MS = 5 * 60_000;

export const getAutomationEventScanCursor = (
  automation: { lastRunAt?: Date | string | null; activatedAt?: Date | string | null },
  now: Date,
): Date => {
  const hasCompletedScan = Boolean(automation.lastRunAt);
  const sourceDate = new Date(
    automation.lastRunAt || automation.activatedAt || now,
  );
  const sourceTime = Number.isNaN(sourceDate.getTime())
    ? now.getTime()
    : sourceDate.getTime();
  const source = sourceTime -
    (hasCompletedScan ? COMMUNICATION_EVENT_SCAN_OVERLAP_MS : 0);
  const recoveryFloor =
    now.getTime() - COMMUNICATION_EVENT_RECOVERY_WINDOW_MS;
  return new Date(Math.max(recoveryFloor, Math.min(source, now.getTime())));
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  [COMMUNICATION_DAY_OF_WEEK.SUNDAY]: 0,
  [COMMUNICATION_DAY_OF_WEEK.MONDAY]: 1,
  [COMMUNICATION_DAY_OF_WEEK.TUESDAY]: 2,
  [COMMUNICATION_DAY_OF_WEEK.WEDNESDAY]: 3,
  [COMMUNICATION_DAY_OF_WEEK.THURSDAY]: 4,
  [COMMUNICATION_DAY_OF_WEEK.FRIDAY]: 5,
  [COMMUNICATION_DAY_OF_WEEK.SATURDAY]: 6,
};

const safeTimezone = (timezone: unknown): string => {
  const value = String(timezone || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
};

const zonedParts = (date: Date, timezone: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "0";
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
    value("weekday")
  ] ?? 0;

  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    weekday,
  };
};

const zonedDateTimeToUtc = (
  parts: Omit<ZonedParts, "weekday">,
  timezone: string,
): Date => {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0,
  );
  let guess = desired;

  // Intl exposes the zone offset indirectly. Iterating the wall-clock delta
  // handles normal offsets as well as DST boundaries without relying on the
  // server process timezone.
  for (let index = 0; index < 4; index += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const actualWallClock = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const correction = desired - actualWallClock;
    if (!correction) break;
    guess += correction;
  }

  return new Date(guess);
};

const parseTime = (value = "09:00") => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match
    ? { hour: Number(match[1]), minute: Number(match[2]) }
    : { hour: 9, minute: 0 };
};

const addUtcDays = (parts: ZonedParts, days: number): ZonedParts => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    weekday: date.getUTCDay(),
  };
};

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

export const calculateNextAutomationRun = (
  automation: ScheduleInput,
  timezone: string,
  after = new Date(),
): Date | null => {
  if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.ONE_TIME_EMAIL) {
    if (!automation.oneTimeSendAt) return null;
    const value = new Date(automation.oneTimeSendAt);
    return Number.isNaN(value.getTime()) || value.getTime() <= after.getTime()
      ? null
      : value;
  }

  if (
    ![
      COMMUNICATION_SCHEDULE_TYPE.DAILY,
      COMMUNICATION_SCHEDULE_TYPE.WEEKLY,
      COMMUNICATION_SCHEDULE_TYPE.MONTHLY,
    ].includes(automation.scheduleType as never)
  ) {
    return null;
  }

  const zone = safeTimezone(timezone);
  const localAfter = zonedParts(after, zone);
  const sendTime = parseTime(automation.sendTime);
  let localCandidate: ZonedParts = {
    ...localAfter,
    ...sendTime,
  };

  if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.WEEKLY) {
    const targetWeekday = WEEKDAY_INDEX[automation.dayOfWeek || "monday"] ?? 1;
    localCandidate = addUtcDays(
      localCandidate,
      (targetWeekday - localAfter.weekday + 7) % 7,
    );
  }

  if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.MONTHLY) {
    const requestedDay = Math.min(Math.max(Number(automation.dayOfMonth || 1), 1), 31);
    localCandidate.day = Math.min(
      requestedDay,
      daysInMonth(localCandidate.year, localCandidate.month),
    );
  }

  let candidate = zonedDateTimeToUtc(localCandidate, zone);
  if (candidate.getTime() > after.getTime()) return candidate;

  if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.DAILY) {
    localCandidate = addUtcDays(localCandidate, 1);
  } else if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.WEEKLY) {
    localCandidate = addUtcDays(localCandidate, 7);
  } else {
    const nextMonth = new Date(Date.UTC(localCandidate.year, localCandidate.month, 1));
    localCandidate = {
      ...localCandidate,
      year: nextMonth.getUTCFullYear(),
      month: nextMonth.getUTCMonth() + 1,
      day: Math.min(
        Math.min(Math.max(Number(automation.dayOfMonth || 1), 1), 31),
        daysInMonth(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1),
      ),
      weekday: nextMonth.getUTCDay(),
    };
  }

  candidate = zonedDateTimeToUtc(localCandidate, zone);
  return candidate;
};

export const getBookingAutomationAnchorField = (
  scheduleType: string,
): "start" | "end" | null => {
  if (
    [
      COMMUNICATION_SCHEDULE_TYPE.BEFORE_BOOKING,
      COMMUNICATION_SCHEDULE_TYPE.BEFORE_PURCHASE,
    ].includes(scheduleType as never)
  ) return "start";
  if (
    [
      COMMUNICATION_SCHEDULE_TYPE.AFTER_BOOKING,
      COMMUNICATION_SCHEDULE_TYPE.AFTER_PURCHASE,
    ].includes(scheduleType as never)
  ) return "end";
  return null;
};

export const getBookingAutomationSourceAnchor = (
  automation: ScheduleInput,
  booking: { start?: Date | string; end?: Date | string },
): Date | null => {
  const field = getBookingAutomationAnchorField(automation.scheduleType);
  if (!field) return null;
  const anchor = new Date(booking[field] || "");
  return Number.isNaN(anchor.getTime()) ? null : anchor;
};

export const getBookingAutomationScheduledFor = (
  automation: ScheduleInput,
  booking: { start?: Date | string; end?: Date | string },
): Date | null => {
  const anchor = getBookingAutomationSourceAnchor(automation, booking);
  if (!anchor) return null;
  const before =
    getBookingAutomationAnchorField(automation.scheduleType) === "start";
  const offsetMs = Math.max(0, Number(automation.minutesOffset || 0)) * 60_000;
  return new Date(anchor.getTime() + (before ? -offsetMs : offsetMs));
};

export const getBookingConfirmationScheduledFor = (
  automation: ScheduleInput,
  order: { paidAt?: Date | string | null },
): Date | null => {
  if (
    automation.scheduleType !== COMMUNICATION_SCHEDULE_TYPE.AFTER_BOOKING_CREATED
  ) return null;
  const confirmedAt = new Date(order.paidAt || "");
  if (Number.isNaN(confirmedAt.getTime())) return null;
  const offsetMs = Math.max(0, Number(automation.minutesOffset || 0)) * 60_000;
  return new Date(confirmedAt.getTime() + offsetMs);
};

export const isWithinAutomationQuietHours = (
  date: Date,
  quietHours: { enabled?: boolean; start?: string; end?: string } | null | undefined,
  timezone: string,
): boolean => {
  if (!quietHours?.enabled) return false;
  const local = zonedParts(date, safeTimezone(timezone));
  const current = local.hour * 60 + local.minute;
  const startTime = parseTime(quietHours.start || "21:00");
  const endTime = parseTime(quietHours.end || "08:00");
  const start = startTime.hour * 60 + startTime.minute;
  const end = endTime.hour * 60 + endTime.minute;
  if (start === end) return true;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
};

export const moveAfterAutomationQuietHours = (
  date: Date,
  quietHours: { enabled?: boolean; start?: string; end?: string } | null | undefined,
  timezone: string,
): Date => {
  const zone = safeTimezone(timezone);
  if (!isWithinAutomationQuietHours(date, quietHours, zone)) return date;

  const local = zonedParts(date, zone);
  const start = parseTime(quietHours?.start || "21:00");
  const end = parseTime(quietHours?.end || "08:00");
  const currentMinutes = local.hour * 60 + local.minute;
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  const crossesMidnight = startMinutes >= endMinutes;
  const shouldUseNextDay = crossesMidnight && currentMinutes >= startMinutes;
  const target = shouldUseNextDay ? addUtcDays(local, 1) : local;

  return zonedDateTimeToUtc(
    {
      year: target.year,
      month: target.month,
      day: target.day,
      hour: end.hour,
      minute: end.minute,
    },
    zone,
  );
};
