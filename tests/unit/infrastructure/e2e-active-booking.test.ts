import { describe, expect, it } from "vitest";

import { findLocationOpeningWindow } from "@/modules/location/location-opening-hours.js";
import { createActiveBookingScenario } from "../../e2e/support/e2e-active-booking.js";

const MINUTE_MS = 60_000;
const timezone = "UTC";

describe("active-booking E2E fixture opening hours", () => {
  it.each([
    "2026-11-05T00:00:01Z",
    "2026-11-05T12:15:00Z",
    "2026-11-05T22:30:01Z",
    "2026-11-05T23:00:01Z",
    "2026-11-05T23:25:00Z",
    "2026-11-05T23:30:01Z",
    "2026-11-05T23:59:59Z",
    "2026-11-06T00:00:01Z",
    "2026-11-08T23:45:00Z", // Sunday into a new week.
    "2026-12-31T23:45:00Z", // A new year.
  ])(
    "keeps the active booking and every extension inside one opening interval at %s",
    (instant) => {
      const now = new Date(instant);
      const duration = 60 * MINUTE_MS;
      const active = createActiveBookingScenario(duration, now);

      expect(active.start.getTime()).toBeLessThan(now.getTime());
      expect(active.end.getTime()).toBeGreaterThan(now.getTime());
      expect(active.end.getTime() - active.start.getTime()).toBe(duration);
      expect(active.start.getUTCMinutes() % 30).toBe(0);

      for (const minutes of [30, 60, 90, 120]) {
        const end = new Date(active.end.getTime() + minutes * MINUTE_MS);
        const window = findLocationOpeningWindow({
          start: active.start,
          end,
          openingHours: active.openingHours,
          timezone,
        });
        expect(window, `+${minutes} minutes at ${instant}`).not.toBeNull();
        expect(window!.start.getTime()).toBeLessThanOrEqual(
          active.start.getTime(),
        );
        expect(window!.end.getTime()).toBeGreaterThanOrEqual(end.getTime());
      }
    },
  );

  it("reproduces the midnight failure even with a 24:00 close, then covers the same extension", () => {
    const active = createActiveBookingScenario(
      60 * MINUTE_MS,
      new Date("2026-11-05T23:25:00Z"),
    );
    const input = {
      start: active.start,
      end: new Date(active.end.getTime() + 30 * MINUTE_MS),
      timezone,
    };
    for (const closeTime of ["23:59", "24:00"]) {
      const openingHours = Object.fromEntries(
        Object.keys(active.openingHours).map((day) => [
          day,
          { isOpen: true, openTime: "00:00", closeTime },
        ]),
      );
      expect(findLocationOpeningWindow({ ...input, openingHours })).toBeNull();
    }
    expect(
      findLocationOpeningWindow({
        ...input,
        openingHours: active.openingHours,
      }),
    ).toEqual({
      start: new Date("2026-11-05T22:00:00Z"),
      end: new Date("2026-11-06T22:00:00Z"),
    });
  });
});
