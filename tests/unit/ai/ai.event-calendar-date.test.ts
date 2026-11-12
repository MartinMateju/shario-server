import { describe, expect, it } from "vitest";

import {
  calendarDateInTimeZone,
  isFutureCalendarDateInTimeZone,
  isValidCalendarDate,
} from "@/modules/ai/services/event-calendar-date.js";

describe("event calendar date boundary", () => {
  it("compares against the selected location calendar day across offsets", () => {
    const now = new Date("2026-08-15T01:00:00.000Z");

    expect(calendarDateInTimeZone("Pacific/Kiritimati", now)).toBe("2026-08-15");
    expect(
      isFutureCalendarDateInTimeZone({
        date: "2026-08-15",
        timeZone: "Pacific/Kiritimati",
        now,
      }),
    ).toBe(false);

    expect(calendarDateInTimeZone("America/Adak", now)).toBe("2026-08-14");
    expect(
      isFutureCalendarDateInTimeZone({
        date: "2026-08-15",
        timeZone: "America/Adak",
        now,
      }),
    ).toBe(true);
  });

  it("fails closed on invalid dates and timezones", () => {
    expect(isValidCalendarDate("2026-02-29")).toBe(false);
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
    expect(
      isFutureCalendarDateInTimeZone({
        date: "2099-01-01",
        timeZone: "",
      }),
    ).toBe(false);
    expect(calendarDateInTimeZone("Not/A-Timezone")).toBeNull();
  });
});
