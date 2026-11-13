import { describe, expect, it } from "vitest";
import { AI_LOCALES } from "@/modules/ai/ai-locale.js";
import { AI_PRODUCT_MESSAGES } from "@/modules/ai/ai-product-messages.js";
import { aiProductText } from "@/modules/ai/ai-product-copy.js";
import {
  buildDailyBriefingAttention,
  buildDailyBriefingSuggestedActions,
  buildDeterministicBriefingNarrative,
  extractDailyBriefingMetrics,
} from "@/modules/ai/services/briefing-snapshot.service.js";
import { buildBusinessAdvisorRecommendations } from "@/modules/ai/services/business-advisor-snapshot.service.js";

const metrics = extractDailyBriefingMetrics({
  coverage: {
    available: ["bookings", "tasks"],
    unavailable: [],
    complete: true,
  },
  bookings: { todayCount: 21, unpaidCount: 2, occupancyPercent: 75 },
  tasks: { openCount: 5, overdueCount: 2, urgent: 1 },
});
const overview = {
  metadata: {
    period: { from: "2026-07-01", to: "2026-07-31" },
    currency: "EUR",
  },
  summary: { netSales: { value: 70000, previous: 100000, changePercent: -30 } },
  sales: { orders: 30 },
  coverage: { available: ["sales"], unavailable: [], complete: true },
};
const attentionFacts = (
  items: ReturnType<typeof buildDailyBriefingAttention>,
) =>
  items.map(({ title: _title, description: _description, ...facts }) => facts);
const adviceFacts = (
  items: ReturnType<typeof buildBusinessAdvisorRecommendations>,
) =>
  items.map(
    ({
      title: _title,
      rationale: _rationale,
      nextStep: _nextStep,
      evidence,
      ...facts
    }) => ({
      ...facts,
      evidence: evidence.map(({ label: _label, ...values }) => values),
    }),
  );

describe("localized deterministic AI product screens", () => {
  it.each(AI_LOCALES)(
    "%s has every deterministic product message",
    (locale) => {
      expect(Object.keys(AI_PRODUCT_MESSAGES[locale] || {}).sort()).toEqual(
        Object.keys(AI_PRODUCT_MESSAGES.en).sort(),
      );
    },
  );

  it.each(AI_LOCALES)(
    "keeps facts intact while translating %s briefing and advice",
    (locale) => {
      const attention = buildDailyBriefingAttention(metrics, locale);
      const advice = buildBusinessAdvisorRecommendations(overview, locale);
      expect(attention.length).toBeGreaterThan(0);
      expect(advice.length).toBeGreaterThan(0);
      expect(attentionFacts(attention)).toEqual(
        attentionFacts(buildDailyBriefingAttention(metrics, "en")),
      );
      expect(adviceFacts(advice)).toEqual(
        adviceFacts(buildBusinessAdvisorRecommendations(overview, "en")),
      );
      const narrative = buildDeterministicBriefingNarrative(
        metrics,
        attention,
        locale,
      );
      const actions = buildDailyBriefingSuggestedActions(attention, locale);
      expect(narrative.summary).toContain("21");
      expect(actions[0].href).toBe("/app/ai?intent=review-daily-briefing");
      if (locale !== "en") {
        expect(narrative.headline).not.toBe(
          buildDeterministicBriefingNarrative(metrics, attention, "en")
            .headline,
        );
        expect(advice[0].title).not.toBe(
          buildBusinessAdvisorRecommendations(overview, "en")[0].title,
        );
        expect(actions[0].label).not.toBe(
          buildDailyBriefingSuggestedActions(attention, "en")[0].label,
        );
      }
    },
  );

  it("fails explicitly for missing copy instead of overlaying English", () => {
    expect(() => aiProductText("nl", "missing.key")).toThrow(
      "Missing AI product translation",
    );
  });
});
