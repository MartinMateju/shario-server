import { describe, expect, it } from "vitest";
import {
  buildLocationOpeningWindow,
  findLocationOpeningWindow,
} from "@/modules/location/location-opening-hours.js";

const hours = { isOpen: true, openTime: "05:00", closeTime: "01:00" };
const openingHours = { monday: hours, tuesday: hours };
const timezone = "Europe/Prague";

describe("overnight location opening intervals", () => {
  it.each([
    ["2026-11-02T23:00:00Z", "2026-11-03T00:00:00Z", true], // Tue00–01 from Monday.
    ["2026-11-03T00:00:00Z", "2026-11-03T00:30:00Z", false], // Closing01.
    ["2026-11-03T03:30:00Z", "2026-11-03T04:00:00Z", false], // Gap04:30–05.
    ["2026-11-03T04:00:00Z", "2026-11-03T05:00:00Z", true], // Opening05.
    ["2026-11-03T22:30:00Z", "2026-11-03T23:30:00Z", true], // 23:30–00:30.
    ["2026-11-03T23:30:00Z", "2026-11-04T00:00:00Z", true], // 00:30–01.
    ["2026-11-02T23:30:00Z", "2026-11-03T04:30:00Z", false], // Cannot bridge closed gap.
  ])("contains %s–%s only when continuously open", (start, end, expected) => {
    expect(
      Boolean(
        findLocationOpeningWindow({
          start: new Date(start),
          end: new Date(end),
          openingHours,
          timezone,
        }),
      ),
    ).toBe(expected);
  });

  it("uses the previous weekday's actual hours even when the current weekday is closed", () => {
    const input = {
      start: new Date("2026-11-02T23:30:00Z"),
      end: new Date("2026-11-03T00:00:00Z"),
      timezone,
    };
    expect(
      findLocationOpeningWindow({
        ...input,
        openingHours: { monday: hours, tuesday: { isOpen: false } },
      }),
    ).not.toBeNull();
    expect(
      findLocationOpeningWindow({
        ...input,
        openingHours: { monday: { isOpen: false }, tuesday: hours },
      }),
    ).toBeNull();
    expect(
      findLocationOpeningWindow({
        ...input,
        openingHours: {
          monday: { ...hours, closeTime: "00:00" },
          tuesday: hours,
        },
      }),
    ).toBeNull();
    expect(
      findLocationOpeningWindow({
        ...input,
        openingHours: {
          monday: { ...hours, closeTime: "00:30" },
          tuesday: hours,
        },
      }),
    ).toBeNull();
  });

  it.each(["00:00", "24:00"])(
    "treats a midnight close %s as the end of the opening day",
    (closeTime) => {
      expect(
        buildLocationOpeningWindow({
          date: "2026-11-02",
          hours: { ...hours, closeTime },
          timezone,
        }),
      ).toEqual({
        start: new Date("2026-11-02T04:00:00Z"),
        end: new Date("2026-11-02T23:00:00Z"),
      });
    },
  );

  it.each([
    ["2027-03-28", "2027-03-28T03:00:00Z", "2027-03-28T23:00:00Z"],
    ["2027-10-31", "2027-10-31T04:00:00Z", "2027-11-01T00:00:00Z"],
  ])(
    "resolves each endpoint in local time on DST transition date %s",
    (date, start, end) => {
      expect(buildLocationOpeningWindow({ date, hours, timezone })).toEqual({
        start: new Date(start),
        end: new Date(end),
      });
    },
  );
});
