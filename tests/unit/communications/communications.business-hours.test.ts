import { describe, expect, it } from "vitest";

import {
  evaluateBusinessHours,
  isWithinQuietHours,
  shouldSendAbsenceReply,
} from "@/modules/communications/services/business-hours.service.js";

const weekdayHours = {
  timezone: "Europe/Prague",
  monday: { enabled: true, open: "09:00", close: "17:00" },
  tuesday: { enabled: true, open: "09:00", close: "17:00" },
  wednesday: { enabled: true, open: "09:00", close: "17:00" },
  thursday: { enabled: true, open: "09:00", close: "17:00" },
  friday: { enabled: true, open: "09:00", close: "17:00" },
  saturday: { enabled: false, open: "09:00", close: "17:00" },
  sunday: { enabled: false, open: "09:00", close: "17:00" },
  holidays: [] as string[],
};

describe("communications business and quiet hours", () => {
  it("evaluates opening hours in the tenant timezone", () => {
    expect(
      evaluateBusinessHours(
        new Date("2026-07-20T08:00:00.000Z"),
        weekdayHours,
      ),
    ).toEqual({
      isOpen: true,
      reason: "open",
      localDate: "2026-07-20",
      localTime: "10:00",
      timezone: "Europe/Prague",
    });
  });

  it("treats close time as an exclusive boundary", () => {
    expect(
      evaluateBusinessHours(
        new Date("2026-07-20T15:00:00.000Z"),
        weekdayHours,
      ),
    ).toMatchObject({
      isOpen: false,
      reason: "outside_hours",
      localTime: "17:00",
    });
  });

  it("distinguishes closed weekdays and configured holidays", () => {
    expect(
      evaluateBusinessHours(
        new Date("2026-07-19T10:00:00.000Z"),
        weekdayHours,
      ),
    ).toMatchObject({ isOpen: false, reason: "closed_day" });

    expect(
      evaluateBusinessHours(
        new Date("2026-07-20T08:00:00.000Z"),
        { ...weekdayHours, holidays: ["2026-07-20"] },
      ),
    ).toMatchObject({ isOpen: false, reason: "holiday" });
  });

  it("carries an overnight interval into the following calendar day", () => {
    const overnight = {
      timezone: "UTC",
      monday: { enabled: true, open: "22:00", close: "02:00" },
      tuesday: { enabled: false, open: "09:00", close: "17:00" },
    };

    expect(
      evaluateBusinessHours(
        new Date("2026-07-20T23:30:00.000Z"),
        overnight,
      ),
    ).toMatchObject({ isOpen: true, reason: "open" });
    expect(
      evaluateBusinessHours(
        new Date("2026-07-21T01:30:00.000Z"),
        overnight,
      ),
    ).toMatchObject({ isOpen: true, reason: "open" });
    expect(
      evaluateBusinessHours(
        new Date("2026-07-21T02:00:00.000Z"),
        overnight,
      ),
    ).toMatchObject({ isOpen: false });
  });

  it("handles quiet hours that cross midnight in the tenant timezone", () => {
    const quiet = { enabled: true, start: "21:00", end: "08:00" };

    expect(
      isWithinQuietHours(
        new Date("2026-07-20T20:30:00.000Z"),
        quiet,
        "Europe/Prague",
      ),
    ).toBe(true);
    expect(
      isWithinQuietHours(
        new Date("2026-07-21T05:59:00.000Z"),
        quiet,
        "Europe/Prague",
      ),
    ).toBe(true);
    expect(
      isWithinQuietHours(
        new Date("2026-07-21T06:00:00.000Z"),
        quiet,
        "Europe/Prague",
      ),
    ).toBe(false);
  });

  it("does not suppress sends when quiet hours are disabled", () => {
    expect(
      isWithinQuietHours(
        new Date("2026-07-20T23:00:00.000Z"),
        { enabled: false, start: "21:00", end: "08:00" },
        "UTC",
      ),
    ).toBe(false);
  });

  it("sends one absence response, then respects the repeat cooldown", () => {
    const now = new Date("2026-07-20T20:00:00.000Z");
    const evaluation = { isOpen: false };

    expect(
      shouldSendAbsenceReply({ evaluation, enabled: true, now }),
    ).toBe(true);
    expect(
      shouldSendAbsenceReply({
        evaluation,
        enabled: true,
        lastReplyAt: new Date("2026-07-20T08:00:00.000Z"),
        repeatAfterHours: 24,
        now,
      }),
    ).toBe(false);
    expect(
      shouldSendAbsenceReply({
        evaluation,
        enabled: true,
        lastReplyAt: new Date("2026-07-19T20:00:00.000Z"),
        repeatAfterHours: 24,
        now,
      }),
    ).toBe(true);
  });

  it("never sends an absence response during open hours or when disabled", () => {
    expect(
      shouldSendAbsenceReply({
        evaluation: { isOpen: true },
        enabled: true,
      }),
    ).toBe(false);
    expect(
      shouldSendAbsenceReply({
        evaluation: { isOpen: false },
        enabled: false,
      }),
    ).toBe(false);
  });
});
