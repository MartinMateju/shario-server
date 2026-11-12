import { describe, expect, it } from "vitest";

import {
  buildStaffPlanningBriefingCatalog,
  buildStaffPlanningAiSignature,
  deterministicStaffPlanningBriefing,
  deterministicStaffPlanningDailyDraft,
  isGroundedStaffPlanningBriefing,
  staffPlanningLocalDayWindow,
} from "@/modules/ai/services/staff-planning-ai.service.js";

const facts = {
  metadata: { date: "2026-07-28" },
  today: {
    counts: {
      submitted: 4,
      missing: 2,
      needsOwnerAttention: 1,
    },
  },
};

describe("staff planning AI safeguards", () => {
  it("accepts only exact server-owned phrase ids", () => {
    const catalog = buildStaffPlanningBriefingCatalog("day", facts, "en");
    const valid = {
      highlightIds: [],
      attentionIds: [
        "day.attention.owner",
        "day.attention.missing",
      ],
      recommendationIds: [],
    };
    expect(isGroundedStaffPlanningBriefing(valid, catalog)).toBe(true);
  });

  it("rejects a date-number collision as a factual phrase id", () => {
    const catalog = buildStaffPlanningBriefingCatalog("day", facts, "en");
    expect(
      isGroundedStaffPlanningBriefing(
        {
          highlightIds: [],
          attentionIds: ["28"],
          recommendationIds: [],
        },
        catalog,
      ),
    ).toBe(false);
  });

  it("rejects qualitative hallucinations outside the phrase catalog", () => {
    const catalog = buildStaffPlanningBriefingCatalog("day", facts, "en");
    expect(
      isGroundedStaffPlanningBriefing(
        {
          highlightIds: ["The team is overwhelmed."],
          attentionIds: [
            "day.attention.owner",
            "day.attention.missing",
          ],
          recommendationIds: [],
        },
        catalog,
      ),
    ).toBe(false);
  });

  it("uses aggregate weekly/monthly facts in deterministic fallback", () => {
    expect(
      deterministicStaffPlanningBriefing(
        "week",
        { week: { planCount: 3 } },
        "en",
      ).summary,
    ).toContain("3");
    expect(
      deterministicStaffPlanningBriefing(
        "month",
        { month: { priorityCount: 5 } },
        "cs",
      ).summary,
    ).toContain("5");
  });

  it("builds review-only drafts exclusively from supplied authoritative tasks", () => {
    const draft = deterministicStaffPlanningDailyDraft(
      [{ id: "a", title: "Prepare clay" }],
      [{ id: "b", title: "Unload kiln", completedAt: new Date() }],
      [{ id: "c", title: "Order glaze" }],
      "cs",
    );
    expect(draft.focusTaskIds).toEqual(["a"]);
    expect(draft.completedTaskIds).toEqual(["b"]);
    expect(draft.blockerTaskIds).toEqual(["c"]);
    expect(draft.dataLimitations.join(" ")).toContain("návrh");
  });

  it("uses tenant-midnight boundaries across 23/25-hour Prague days", () => {
    const spring = staffPlanningLocalDayWindow(
      "2026-03-29",
      "Europe/Prague",
    );
    const autumn = staffPlanningLocalDayWindow(
      "2026-10-25",
      "Europe/Prague",
    );
    expect(spring.end.getTime() - spring.start.getTime()).toBe(
      23 * 60 * 60 * 1_000,
    );
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(
      25 * 60 * 60 * 1_000,
    );
  });

  it("omits volatile timestamps from the idempotency signature", () => {
    const base = {
      tenantId: "tenant",
      userId: "user",
      locationAccess: null,
      locale: "en",
      cadence: "day",
    };
    const first = buildStaffPlanningAiSignature({
      ...base,
      facts: { ...facts, generatedAt: "2026-07-28T08:00:00.000Z" },
    });
    const second = buildStaffPlanningAiSignature({
      ...base,
      facts: { ...facts, generatedAt: "2026-07-28T09:00:00.000Z" },
    });
    expect(first).toBe(second);
  });
});
