import { describe, expect, it } from "vitest";

import {
  calculateNextAutomationRun,
  getBookingAutomationScheduledFor,
  getBookingConfirmationScheduledFor,
  isWithinAutomationQuietHours,
  moveAfterAutomationQuietHours,
} from "@/modules/communication-automations/services/communication-automation-schedule.service.js";

describe("communication automation scheduling", () => {
  it("calculates daily wall-clock time across a DST transition", () => {
    expect(
      calculateNextAutomationRun(
        { scheduleType: "daily", sendTime: "09:00" },
        "Europe/Prague",
        new Date("2026-03-28T10:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-03-29T07:00:00.000Z");
  });

  it("supports weekly and end-of-month schedules", () => {
    expect(
      calculateNextAutomationRun(
        { scheduleType: "weekly", dayOfWeek: "monday", sendTime: "08:30" },
        "UTC",
        new Date("2026-07-31T10:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-03T08:30:00.000Z");
    expect(
      calculateNextAutomationRun(
        { scheduleType: "monthly", dayOfMonth: 31, sendTime: "09:00" },
        "UTC",
        new Date("2026-04-01T00:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-04-30T09:00:00.000Z");
  });

  it("rejects past one-time dates and keeps future dates exact", () => {
    const now = new Date("2026-07-31T10:00:00.000Z");
    expect(
      calculateNextAutomationRun(
        { scheduleType: "oneTimeEmail", oneTimeSendAt: "2026-07-31T09:00:00Z" },
        "UTC",
        now,
      ),
    ).toBeNull();
    expect(
      calculateNextAutomationRun(
        { scheduleType: "oneTimeEmail", oneTimeSendAt: "2026-07-31T11:00:00Z" },
        "UTC",
        now,
      )?.toISOString(),
    ).toBe("2026-07-31T11:00:00.000Z");
  });

  it("calculates booking reminders from the correct immutable anchor", () => {
    const booking = {
      start: "2026-08-01T10:00:00.000Z",
      end: "2026-08-01T12:00:00.000Z",
    };
    expect(
      getBookingAutomationScheduledFor(
        { scheduleType: "beforeBooking", minutesOffset: 60 },
        booking,
      )?.toISOString(),
    ).toBe("2026-08-01T09:00:00.000Z");
    expect(
      getBookingAutomationScheduledFor(
        { scheduleType: "afterBooking", minutesOffset: 30 },
        booking,
      )?.toISOString(),
    ).toBe("2026-08-01T12:30:00.000Z");
  });

  it("detects cross-midnight quiet hours and moves to their end", () => {
    const quietHours = { enabled: true, start: "21:00", end: "08:00" };
    const during = new Date("2026-07-31T22:00:00.000Z");
    expect(isWithinAutomationQuietHours(during, quietHours, "UTC")).toBe(true);
    expect(moveAfterAutomationQuietHours(during, quietHours, "UTC").toISOString())
      .toBe("2026-08-01T08:00:00.000Z");
  });

  it("schedules each customer booking from payment confirmation, not session creation", () => {
    const automation = { scheduleType: "afterBookingCreated", minutesOffset: 2 };
    const order = { paidAt: "2026-07-31T10:00:00.000Z" };
    expect(getBookingConfirmationScheduledFor(automation, order)?.toISOString())
      .toBe("2026-07-31T10:02:00.000Z");
    expect(getBookingConfirmationScheduledFor(automation, { paidAt: null }))
      .toBeNull();
  });
});
