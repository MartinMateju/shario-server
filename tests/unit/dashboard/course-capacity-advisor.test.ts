import { describe, expect, it } from "vitest";

import {
  analyzeRepeatedCourseSaturation,
  buildCourseCapacityAdvisorPeriod,
} from "@/modules/dashboard/course-capacity-advisor.service.js";

const PRODUCT_ID = "507f1f77bcf86cd799439015";

const session = ({
  id,
  start,
  seats,
}: {
  id: string;
  start: string;
  seats: number;
}) => ({
  _id: id,
  start: new Date(start),
  end: new Date(new Date(start).valueOf() + 2 * 60 * 60 * 1_000),
  participants: Array.from({ length: seats }, (_, index) => ({
    firstname: `Guest ${index}`,
    lastname: "Test",
  })),
  numberOfGuests: seats,
  bookingProduct: {
    _id: PRODUCT_ID,
    name: "Saturday wheel",
    type: "course",
    maxNumberOfParticipants: 10,
  },
});

describe("course capacity advisor", () => {
  it("does not recommend capacity increases because removed paid rows remain in the roster", () => {
    const period = buildCourseCapacityAdvisorPeriod({ timezone: "Europe/Prague", now: new Date("2026-07-25T12:00:00.000Z") });
    const rows = ["2026-07-04", "2026-07-11", "2026-07-18"].map((date, index) => ({
      ...session({ id: `session-${index}`, start: `${date}T08:00:00.000Z`, seats: 10 }),
      numberOfGuests: 1,
      participants: Array.from({ length: 10 }, (_, seat) => ({
        firstname: "Guest", lastname: "Test", attendanceStatus: seat === 0 ? "active" : "removed", order: "paid-order",
      })),
    }));
    expect(analyzeRepeatedCourseSaturation({ period, rows })).toBeNull();
  });
  it("recommends a capacity review only from repeated high-fill slot evidence", () => {
    const period = buildCourseCapacityAdvisorPeriod({
      timezone: "Europe/Prague",
      now: new Date("2026-07-25T12:00:00.000Z"),
    });
    const signal = analyzeRepeatedCourseSaturation({
      period,
      rows: [
        session({
          id: "session-1",
          start: "2026-07-04T08:00:00.000Z",
          seats: 9,
        }),
        session({
          id: "session-2",
          start: "2026-07-11T08:00:00.000Z",
          seats: 10,
        }),
        session({
          id: "session-3",
          start: "2026-07-18T08:00:00.000Z",
          seats: 9,
        }),
      ],
    });

    expect(signal).toMatchObject({
      key: "repeatedCourseSaturation",
      value: 93.3,
      productId: PRODUCT_ID,
      courseName: "Saturday wheel",
      weekday: 5,
      weekdayKey: "saturday",
      localStartTime: "10:00",
      sessionCount: 3,
      highFillSessionCount: 3,
      averageFillPercent: 93.3,
      totalBookedSeats: 28,
      totalCapacity: 30,
      threshold: {
        minimumHighFillSessions: 3,
        minimumAverageFillPercent: 90,
      },
      capacityBasis: "current_product_capacity",
      recommendation: {
        kind: "review_or_increase_capacity",
        automaticChange: false,
      },
      evidence: {
        total: 3,
        truncated: false,
      },
    });
    expect(signal?.period).toMatchObject({
      key: "recent_56_tenant_calendar_days",
      days: 56,
      timezone: "Europe/Prague",
      to: "2026-07-25",
    });
    expect(signal?.evidence.items.map((item) => item.sessionId)).toEqual([
      "session-3",
      "session-2",
      "session-1",
    ]);
  });

  it("does not recommend capacity from fewer than three high-fill sessions", () => {
    const period = buildCourseCapacityAdvisorPeriod({
      timezone: "Europe/Prague",
      now: new Date("2026-07-25T12:00:00.000Z"),
    });
    const signal = analyzeRepeatedCourseSaturation({
      period,
      rows: [
        session({
          id: "session-1",
          start: "2026-07-11T08:00:00.000Z",
          seats: 10,
        }),
        session({
          id: "session-2",
          start: "2026-07-18T08:00:00.000Z",
          seats: 10,
        }),
      ],
    });

    expect(signal).toBeNull();
  });

  it("does not recommend capacity when the recurring slot average is below ninety percent", () => {
    const period = buildCourseCapacityAdvisorPeriod({
      timezone: "Europe/Prague",
      now: new Date("2026-07-25T12:00:00.000Z"),
    });
    const signal = analyzeRepeatedCourseSaturation({
      period,
      rows: [
        session({
          id: "session-1",
          start: "2026-06-20T08:00:00.000Z",
          seats: 10,
        }),
        session({
          id: "session-2",
          start: "2026-06-27T08:00:00.000Z",
          seats: 10,
        }),
        session({
          id: "session-3",
          start: "2026-07-04T08:00:00.000Z",
          seats: 10,
        }),
        session({
          id: "session-4",
          start: "2026-07-11T08:00:00.000Z",
          seats: 4,
        }),
        session({
          id: "session-5",
          start: "2026-07-18T08:00:00.000Z",
          seats: 4,
        }),
      ],
    });

    expect(signal).toBeNull();
  });
});
