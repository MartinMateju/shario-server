import { describe, expect, it } from "vitest";

import {
  buildUTCBookingRangeFromLocalInputs,
  buildUTCDateFromLocalDateAndTime,
} from "@/shared/time/time.utils.js";

const iso = (value: Date | null | undefined) => value?.toISOString();

describe("local wall-clock times on daylight-saving change days", () => {
  it.each([
    // Spring forward in Prague: 10:00 local is already UTC+2.
    ["2027-03-28", "10:00", "Europe/Prague", "2027-03-28T08:00:00.000Z"],
    // Fall back in Prague: 10:00 local is already UTC+1.
    ["2027-10-31", "10:00", "Europe/Prague", "2027-10-31T09:00:00.000Z"],
    ["2027-03-14", "10:00", "America/New_York", "2027-03-14T14:00:00.000Z"],
    ["2027-11-07", "10:00", "America/New_York", "2027-11-07T15:00:00.000Z"],
    ["2027-10-03", "10:00", "Australia/Sydney", "2027-10-02T23:00:00.000Z"],
    // Ordinary days are unchanged.
    ["2027-06-15", "10:00", "Europe/Prague", "2027-06-15T08:00:00.000Z"],
    ["2027-01-15", "00:00", "Europe/Prague", "2027-01-14T23:00:00.000Z"],
  ])("%s %s in %s", (date, time, timezone, expected) => {
    expect(
      iso(buildUTCDateFromLocalDateAndTime({ date, time, timezone })),
    ).toBe(expected);
  });

  it("ends an overnight range at the same wall-clock time next day", () => {
    const range = buildUTCBookingRangeFromLocalInputs({
      date: "2027-03-27",
      startTime: "23:00",
      endTime: "04:00",
      timezone: "Europe/Prague",
    });

    expect(iso(range?.start)).toBe("2027-03-27T22:00:00.000Z");
    // 04:00 on 28 March is UTC+2, so only four elapsed hours.
    expect(iso(range?.end)).toBe("2027-03-28T02:00:00.000Z");
  });

  it("keeps the full-day opening range ending at next local midnight", () => {
    const range = buildUTCBookingRangeFromLocalInputs({
      date: "2027-10-31",
      startTime: "06:00",
      endTime: "00:00",
      timezone: "Europe/Prague",
    });

    expect(iso(range?.start)).toBe("2027-10-31T05:00:00.000Z");
    expect(iso(range?.end)).toBe("2027-10-31T23:00:00.000Z");
  });
});
