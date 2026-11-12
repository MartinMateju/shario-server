export const calendarDateInTimeZone = (
  timeZone: string,
  now: Date = new Date(),
): string | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const value = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return value.year && value.month && value.day
      ? `${value.year}-${value.month}-${value.day}`
      : null;
  } catch {
    return null;
  }
};

export const isValidCalendarDate = (date: string): boolean => {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
};

export const isFutureCalendarDateInTimeZone = ({
  date,
  timeZone,
  now = new Date(),
}: {
  date: string;
  timeZone: string;
  now?: Date;
}): boolean => {
  const today = calendarDateInTimeZone(timeZone, now);
  return Boolean(today && isValidCalendarDate(date) && date > today);
};
