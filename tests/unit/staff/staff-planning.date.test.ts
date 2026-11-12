import { describe, expect, it } from "vitest";

import {
  assertMondayKey,
  planningDateRange,
  planningToday,
  resolvePlanningDate,
} from "@/modules/staff/staff-planning.date.js";

describe("staff planning tenant calendar", () => {
  it("resolves the tenant date independently from UTC", () => {
    expect(
      planningToday(
        "Europe/Prague",
        new Date("2026-07-27T22:30:00.000Z"),
      ),
    ).toBe("2026-07-28");
    expect(
      planningToday(
        "America/Los_Angeles",
        new Date("2026-07-28T02:30:00.000Z"),
      ),
    ).toBe("2026-07-27");
  });

  it("keeps Monday-first week and month keys around DST changes", () => {
    expect(
      planningDateRange("2026-03-29", "Europe/Prague"),
    ).toMatchObject({
      isoWeekday: 7,
      week: { from: "2026-03-23", to: "2026-03-29" },
      month: { key: "2026-03" },
    });
    expect(
      planningDateRange("2026-10-25", "Europe/Prague"),
    ).toMatchObject({
      isoWeekday: 7,
      week: { from: "2026-10-19", to: "2026-10-25" },
      month: { key: "2026-10" },
    });
  });

  it("rejects invalid dates and non-Monday weekly keys", () => {
    expect(() =>
      resolvePlanningDate("2026-02-30", "Europe/Prague"),
    ).toThrow();
    expect(() =>
      assertMondayKey("2026-07-28", "Europe/Prague"),
    ).toThrow();
    expect(
      assertMondayKey("2026-07-27", "Europe/Prague"),
    ).toBe("2026-07-27");
  });
});

