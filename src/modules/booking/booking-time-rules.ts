import { buildUTCBookingRangeFromLocalInputs } from "@/shared/time/time.utils.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";

/**
 * Time rules every customer-created Open Studio booking must satisfy:
 * a valid future range, an allowed duration, the studio's slot grid and
 * opening hours. Shared by booking intents and cart checkout.
 */
type ZonedParts = {
  date: string;
  weekday: string;
  minuteOfDay: number;
  second: number;
};

const getZonedParts = (date: Date, timeZone: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: String(values.weekday || "").toLowerCase(),
    minuteOfDay: hour * 60 + minute,
    second: Number(values.second),
  };
};

export const assertTimedRange = ({
  payload,
  location,
  now,
  openingHours: openingHoursPolicy = "required",
}: {
  payload: { start: Date | null; end: Date | null };
  location: any;
  now: Date;
  /**
   * "when-configured" skips only the opening-hours check for a location that
   * has no opening hours stored at all (legacy data); every other rule still
   * applies.
   */
  openingHours?: "required" | "when-configured";
}): { durationMinutes: number; billingBlocks: number } => {
  if (!payload.start || !payload.end) {
    badRequest({
      message: "A start and end time are required.",
      code: "BOOKING_TIME_REQUIRED",
    });
  }

  const startMs = payload.start.getTime();
  const endMs = payload.end.getTime();

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    badRequest({
      message: "The selected booking time is invalid.",
      code: "BOOKING_TIME_INVALID",
    });
  }

  if (startMs <= now.getTime()) {
    conflict({
      message: "The selected booking time is in the past.",
      code: "BOOKING_TIME_IN_PAST",
    });
  }

  const durationMs = endMs - startMs;
  const durationMinutes = durationMs / 60_000;

  if (!Number.isSafeInteger(durationMinutes)) {
    badRequest({
      message: "Booking duration must use whole minutes.",
      code: "BOOKING_DURATION_INVALID",
    });
  }

  const minMinutes = Math.max(
    15,
    Number(location.booking?.minBookingMinutes ?? 60),
  );
  const maxMinutes = Math.max(
    minMinutes,
    Number(location.booking?.maxBookingMinutes ?? 360),
  );
  const stepMinutes = Math.max(
    15,
    Number(location.booking?.slotStepMinutes ?? 30),
  );

  if (
    durationMinutes < minMinutes ||
    durationMinutes > maxMinutes ||
    durationMinutes % stepMinutes !== 0
  ) {
    badRequest({
      message: "The selected booking duration is not allowed.",
      code: "BOOKING_DURATION_INVALID",
      details: { minMinutes, maxMinutes, stepMinutes },
    });
  }

  const timeZone = String(location.booking?.timezone || "Europe/Prague");
  const startParts = getZonedParts(payload.start, timeZone);
  const endParts = getZonedParts(payload.end, timeZone);

  if (
    startParts.minuteOfDay % stepMinutes !== 0 ||
    startParts.second !== 0 ||
    payload.start.getUTCMilliseconds() !== 0 ||
    endParts.second !== 0 ||
    payload.end.getUTCMilliseconds() !== 0
  ) {
    badRequest({
      message: "The selected time must align with the studio booking grid.",
      code: "BOOKING_TIME_STEP_INVALID",
      details: { stepMinutes },
    });
  }

  const configuredDays = Object.values(location.openingHours ?? {}).filter(
    (day) => day && typeof day === "object",
  );
  if (openingHoursPolicy === "when-configured" && !configuredDays.length) {
    return {
      durationMinutes,
      billingBlocks: Math.ceil(durationMinutes / 30),
    };
  }

  const openingHours = location.openingHours?.[startParts.weekday];

  if (!openingHours?.isOpen) {
    conflict({
      message: "The studio is closed at the selected time.",
      code: "BOOKING_OUTSIDE_OPENING_HOURS",
    });
  }

  const openingRange = buildUTCBookingRangeFromLocalInputs({
    date: startParts.date,
    startTime: String(openingHours.openTime || "06:00"),
    endTime:
      String(openingHours.closeTime || "24:00") === "24:00"
        ? "00:00"
        : String(openingHours.closeTime),
    timezone: timeZone,
  });

  if (
    !openingRange ||
    startMs < openingRange.start.getTime() ||
    endMs > openingRange.end.getTime()
  ) {
    conflict({
      message: "The selected time is outside studio opening hours.",
      code: "BOOKING_OUTSIDE_OPENING_HOURS",
    });
  }

  return {
    durationMinutes,
    billingBlocks: Math.ceil(durationMinutes / 30),
  };
};
