import { describe, expect, it } from "vitest";

import {
  buildReportBuckets,
  resolveReportPeriod,
} from "@/modules/reports/reports.date.js";

const query = {
  compare: true,
  granularity: "auto" as const,
};

describe("report date periods", () => {
  it("uses inclusive tenant-local dates and an equal previous period", () => {
    const result = resolveReportPeriod({
      query: {
        ...query,
        from: "2026-07-01",
        to: "2026-07-30",
      },
      timezone: "Europe/Prague",
    });

    expect(result.current).toMatchObject({
      from: "2026-07-01",
      to: "2026-07-30",
      days: 30,
    });
    expect(result.comparison).toMatchObject({
      from: "2026-06-01",
      to: "2026-06-30",
      days: 30,
    });
    expect(result.granularity).toBe("day");
  });

  it("preserves local calendar boundaries across spring DST", () => {
    const result = resolveReportPeriod({
      query: {
        compare: false,
        granularity: "day",
        from: "2026-03-29",
        to: "2026-03-29",
      },
      timezone: "Europe/Prague",
    });

    expect(
      result.current.endExclusive.valueOf() - result.current.start.valueOf(),
    ).toBe(23 * 60 * 60 * 1000);
  });

  it("preserves local calendar boundaries across autumn DST", () => {
    const result = resolveReportPeriod({
      query: {
        compare: false,
        granularity: "day",
        from: "2026-10-25",
        to: "2026-10-25",
      },
      timezone: "Europe/Prague",
    });

    expect(
      result.current.endExclusive.valueOf() - result.current.start.valueOf(),
    ).toBe(25 * 60 * 60 * 1000);
  });

  it.each([
    ["2026-03-28", "2026-03-30"],
    ["2026-10-24", "2026-10-26"],
  ])(
    "builds exactly one tenant-local daily bucket across DST from %s to %s",
    (from, to) => {
      const result = resolveReportPeriod({
        query: {
          compare: false,
          granularity: "day",
          from,
          to,
        },
        timezone: "Europe/Prague",
      });
      const buckets = buildReportBuckets({
        period: result.current,
        timezone: "Europe/Prague",
        granularity: "day",
      });

      expect(buckets).toHaveLength(3);
      expect(new Set(buckets.map((bucket) => bucket.periodStart)).size).toBe(3);
      expect(buckets.map((bucket) => bucket.periodStart)).toEqual([
        from,
        from.startsWith("2026-03") ? "2026-03-29" : "2026-10-25",
        to,
      ]);
    },
  );

  it("rejects invalid dates, reversed ranges and more than 366 days", () => {
    expect(() =>
      resolveReportPeriod({
        query: {
          compare: false,
          granularity: "auto",
          from: "2026-02-30",
          to: "2026-03-01",
        },
        timezone: "UTC",
      }),
    ).toThrow();
    expect(() =>
      resolveReportPeriod({
        query: {
          compare: false,
          granularity: "auto",
          from: "2026-07-02",
          to: "2026-07-01",
        },
        timezone: "UTC",
      }),
    ).toThrow();
    expect(() =>
      resolveReportPeriod({
        query: {
          compare: false,
          granularity: "auto",
          from: "2025-01-01",
          to: "2026-01-02",
        },
        timezone: "UTC",
      }),
    ).toThrow();
  });
});
