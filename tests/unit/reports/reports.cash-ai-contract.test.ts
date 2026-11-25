import { describe, expect, it } from "vitest";

import {
  buildReportBriefingSignature,
  isGroundedReportBriefing,
} from "@/modules/ai/services/report-briefing.service.js";
import {
  buildBusinessAdvisorRecommendations,
  businessAdvisorCoverage,
} from "@/modules/ai/services/business-advisor-snapshot.service.js";

const facts = {
  metadata: {
    period: { from: "2026-01-01", to: "2026-11-17" },
    moneyBasis: "recorded_cash_after_refunds",
    refundBasis: "current_recorded_state",
    cashAsOf: "2026-11-17T10:00:00.000Z",
    currency: "CZK",
  },
  summary: {
    netSales: { value: 70000, previous: 100000, changePercent: -30 },
  },
  sales: {
    orders: 30,
    bestMonth: { month: "2026-06", cashReceivedMinor: 70000 },
    monthlyRanking: [
      {
        month: "2026-06",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        cashReceivedMinor: 70000,
      },
    ],
  },
  coverage: {
    available: ["sales"],
    unavailable: [],
    limitations: [],
    complete: true,
  },
};

describe("cash report AI contract", () => {
  it("does not reuse the same briefing after a refund changes recorded cash", () => {
    const input = {
      tenantId: "tenant",
      userId: "owner",
      locationAccess: { mode: "all" },
      locale: "en",
      query: { compare: true, granularity: "month" as const },
      facts,
    };
    const refreshed = {
      ...facts,
      metadata: { ...facts.metadata, cashAsOf: "2026-11-17T10:01:00.000Z" },
    };
    expect(buildReportBriefingSignature({ ...input, facts: refreshed })).toBe(
      buildReportBriefingSignature(input),
    );
    const refunded = {
      ...refreshed,
      summary: {
        netSales: { value: 60000, previous: 100000, changePercent: -40 },
      },
    };
    expect(
      buildReportBriefingSignature({ ...input, facts: refunded }),
    ).not.toBe(buildReportBriefingSignature(input));
  });

  it("allows an authorized best-month date but rejects an invented month", () => {
    const briefing = {
      headline: "Best month: 2026-06",
      summary: "Recorded payments after refunds.",
      highlights: [],
      attention: [],
      recommendations: [],
      dataLimitations: [],
    };
    expect(isGroundedReportBriefing(briefing, facts)).toBe(true);
    expect(
      isGroundedReportBriefing(
        { ...briefing, headline: "Best month: 2026-09" },
        facts,
      ),
    ).toBe(false);
  });

  it.each(["en", "cs"])("labels cash advice accurately in %s", (locale) => {
    const card = buildBusinessAdvisorRecommendations(facts, locale).find(
      ({ key }) => key === "revenue.net_sales_decline",
    );
    expect(card).toBeDefined();
    expect(card?.evidence[0]?.label).toBe(
      locale === "cs"
        ? "Přijaté platby po vrácení peněz"
        : "Received payments after refunds",
    );
    expect(card?.rationale).not.toMatch(/net sales|čisté tržby|profit|zisk/i);
  });

  it("does not call limited coverage complete in advisor output", () => {
    expect(
      businessAdvisorCoverage({
        available: ["sales"],
        unavailable: [],
        complete: true,
        limitations: ["Some legacy payments have no recorded date."],
      }).complete,
    ).toBe(false);
  });
});
