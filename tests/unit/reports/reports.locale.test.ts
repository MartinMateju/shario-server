import { describe, expect, it } from "vitest";

import {
  deterministicInsights,
  resolveReportLocale,
} from "@/modules/reports/reports.service.js";
import { reportQuerySchema } from "@/modules/reports/reports.validators.js";

const facts = {
  summary: {
    netSales: { value: 100, previous: 50, changePercent: 100 },
    bookings: { value: 2, previous: 1, changePercent: 100 },
    utilizationPercent: { value: 20, previous: null, changePercent: null },
  },
  coverage: { available: [], unavailable: [], limitations: [], complete: true },
};

describe("report presentation language", () => {
  it("uses the requested English workspace language ahead of a saved Czech preference", () => {
    const query = reportQuerySchema.parse({ locale: "en-GB" });
    const locale = resolveReportLocale(query.locale, "cs", "cs");
    const insights = deterministicInsights({ ...facts, locale });
    expect(locale).toBe("en-gb");
    expect(insights.highlights).toContain(
      "Bookings changed by 100% versus the previous period.",
    );
    expect(insights.recommendations[0]).toMatch(/^Review /);
  });

  it("supports Czech requests and preserves existing preference fallback for old API clients", () => {
    expect(
      deterministicInsights({
        ...facts,
        locale: resolveReportLocale("cs-CZ", "en"),
      }).highlights[0],
    ).toMatch(/^Tržby /);
    expect(resolveReportLocale(undefined, "cz", "en")).toBe("cs");
    expect(resolveReportLocale(undefined, undefined, "en")).toBe("en");
    expect(reportQuerySchema.parse({})).not.toHaveProperty("locale");
  });

  it.each(["en_US", "not a locale", "a".repeat(36)])(
    "rejects malformed locale %s before report generation",
    (locale) => {
      expect(reportQuerySchema.safeParse({ locale }).success).toBe(false);
    },
  );
});
