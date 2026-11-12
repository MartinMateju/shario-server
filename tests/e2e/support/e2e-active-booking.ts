const HALF_HOUR_MS = 30 * 60_000;
const HOUR_MS = 60 * 60_000;

export const createActiveBookingScenario = (
  durationMs: number,
  now = new Date(),
) => {
  const start = new Date(
    Math.floor(now.getTime() / HALF_HOUR_MS) * HALF_HOUR_MS,
  );
  const end = new Date(start.getTime() + durationMs);
  // The E2E location uses UTC. Anchor a single 24-hour opening interval before
  // this booking so late-night extensions do not cross a daily closing time.
  // Equal opening/closing times already mean an interval ending the next day.
  const openingTime = new Date(start.getTime() - HOUR_MS)
    .toISOString()
    .slice(11, 16);
  const openingHours = Object.fromEntries(
    [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ].map((day) => [
      day,
      { isOpen: true, openTime: openingTime, closeTime: openingTime },
    ]),
  );
  return { start, end, openingHours };
};
