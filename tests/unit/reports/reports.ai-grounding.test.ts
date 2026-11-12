import { describe, expect, it } from "vitest";

import {
  buildReportBriefingSignature,
  deterministicReportBriefing,
  isGroundedReportBriefing,
} from "@/modules/ai/services/report-briefing.service.js";

const facts = {
  metadata: { period: { from: "2026-07-01", to: "2026-07-31" } },
  summary: {
    bookings: { value: 12, previous: 10, changePercent: 20 },
    netSales: { value: null, previous: null, changePercent: null },
  },
  coverage: {
    available: ["bookings"],
    unavailable: [],
    limitations: ["Sales are unavailable because payments.view is missing."],
  },
};

const output = {
  headline: "July report",
  summary: "Bookings changed by 20%.",
  highlights: ["There were 12 bookings."],
  attention: [],
  recommendations: [],
  dataLimitations: [],
};

describe("report AI grounding", () => {
  it("accepts only numbers present in the authorized facts", () => {
    expect(isGroundedReportBriefing(output, facts)).toBe(true);
    expect(
      isGroundedReportBriefing(
        { ...output, highlights: ["There were 99 bookings."] },
        facts,
      ),
    ).toBe(false);
  });

  it("rejects unsupported causal claims even when their numbers are grounded", () => {
    expect(
      isGroundedReportBriefing(
        {
          ...output,
          summary: "Bookings changed by 20% because marketing worked.",
        },
        facts,
      ),
    ).toBe(false);
  });

  it("allows an exact authorized limitation containing causal wording", () => {
    expect(
      isGroundedReportBriefing(
        {
          ...output,
          dataLimitations: [
            "Sales are unavailable because payments.view is missing.",
          ],
        },
        facts,
      ),
    ).toBe(true);
  });

  it("rejects invented nonnumeric limitations", () => {
    expect(
      isGroundedReportBriefing(
        {
          ...output,
          dataLimitations: ["The kiln sensor was offline."],
        },
        facts,
      ),
    ).toBe(false);
  });

  it("omits volatile generated and snapshot timestamps from idempotency", () => {
    const base = {
      tenantId: "tenant",
      userId: "user",
      locationAccess: { mode: "all", locationIds: [] },
      locale: "en",
      query: { compare: true, granularity: "day" as const },
    };
    const first = buildReportBriefingSignature({
      ...base,
      facts: {
        ...facts,
        metadata: {
          ...facts.metadata,
          generatedAt: "2026-07-28T10:00:00.000Z",
        },
        operations: { inventory: { asOf: "2026-07-28T10:00:00.000Z" } },
      },
    });
    const second = buildReportBriefingSignature({
      ...base,
      facts: {
        ...facts,
        metadata: {
          ...facts.metadata,
          generatedAt: "2026-07-28T10:01:00.000Z",
        },
        operations: { inventory: { asOf: "2026-07-28T10:01:00.000Z" } },
      },
    });
    expect(first).toBe(second);
  });

  it("localizes deterministic fallback insights using the requested locale", () => {
    const briefing = deterministicReportBriefing(
      {
        metadata: { period: { from: "2026-07-01", to: "2026-07-31" } },
        summary: {
          netSales: { value: 100, previous: 50, changePercent: 100 },
          bookings: { value: 12, previous: 10, changePercent: 20 },
          utilizationPercent: {
            value: 25,
            previous: 30,
            changePercent: -16.67,
          },
        },
        coverage: {
          available: ["sales", "bookings"],
          unavailable: [],
          limitations: [],
          complete: true,
        },
        insights: {
          highlights: ["This stale English copy must not be reused."],
          attention: [],
          recommendations: [],
        },
      },
      "cs",
    );

    expect(briefing.headline).toBe("Přehled výsledků studia");
    expect(briefing.highlights.join(" ")).toContain("Tržby");
    expect(briefing.highlights.join(" ")).not.toContain("stale English");
  });
});
