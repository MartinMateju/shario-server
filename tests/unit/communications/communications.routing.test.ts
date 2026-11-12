import { describe, expect, it } from "vitest";

import {
  routeConversation,
  selectRoutingRule,
  type RoutingRule,
} from "@/modules/communications/services/routing.service.js";

describe("communications intelligent routing", () => {
  it("selects the first enabled matching rule by explicit order", () => {
    const decision = routeConversation(
      {
        category: "firing_question",
        channel: "email",
        language: "cs",
        locationId: "vaclavska",
        priority: "normal",
      },
      [
        {
          _id: "generic",
          order: 200,
          conditions: { categories: ["firing_question"] },
          action: { assignTeam: "general-firing" },
        },
        {
          _id: "specific",
          order: 10,
          conditions: {
            categories: ["firing_question"],
            channels: ["email"],
            languages: ["cs"],
            locationIds: ["vaclavska"],
          },
          action: {
            assignTo: "kiln-manager",
            assignTeam: "vaclavska-firing",
            priority: "high",
            addTags: ["kiln", "kiln", "vaclavska"],
            notifyOwner: true,
          },
        },
      ],
    );

    expect(decision).toEqual({
      matchedRuleId: "specific",
      assignedTo: "kiln-manager",
      assignedTeam: "vaclavska-firing",
      locationId: null,
      priority: "high",
      tags: ["kiln", "vaclavska"],
      notifyOwner: true,
    });
  });

  it("uses all-match semantics by default", () => {
    expect(
      routeConversation(
        { category: "firing_question", language: "en" },
        [
          {
            id: "requires-both",
            conditions: {
              categories: ["firing_question"],
              languages: ["cs"],
            },
            action: { assignTeam: "cs-firing" },
          },
        ],
      ),
    ).toBeNull();
  });

  it("supports any-match rules for shared specialist queues", () => {
    expect(
      selectRoutingRule(
        { category: "general", priority: "urgent" },
        [
          {
            id: "urgent-or-access",
            matchOperator: "any",
            conditions: {
              categories: ["access_problem"],
              priorities: ["urgent"],
            },
            action: { assignTeam: "on-duty", notifyOwner: true },
          },
        ],
      ),
    ).toMatchObject({
      matchedRuleId: "urgent-or-access",
      assignedTeam: "on-duty",
      notifyOwner: true,
    });
  });

  it("matches customer language and keywords without case sensitivity", () => {
    expect(
      routeConversation(
        {
          language: "en",
          text: "The DOOR CODE does not work for my booking",
        },
        [
          {
            id: "access",
            conditions: {
              languages: ["en"],
              keywords: ["door code", "locked out"],
            },
            action: { assignTeam: "front-desk", priority: "urgent" },
          },
        ],
      ),
    ).toMatchObject({
      matchedRuleId: "access",
      assignedTeam: "front-desk",
      priority: "urgent",
    });
  });

  it("routes unmatched after-hours conversations only when both facts apply", () => {
    const rule: RoutingRule = {
      id: "review-after-hours",
      conditions: { unmatchedOnly: true, outsideBusinessHours: true },
      action: { assignTeam: "needs-review", notifyOwner: true },
    };

    expect(
      routeConversation(
        { unmatched: true, outsideBusinessHours: true },
        [rule],
      ),
    ).toMatchObject({ matchedRuleId: "review-after-hours" });
    expect(
      routeConversation(
        { unmatched: true, outsideBusinessHours: false },
        [rule],
      ),
    ).toBeNull();
  });

  it("skips disabled rules and falls back to an unconditional rule", () => {
    expect(
      routeConversation(
        { category: "payment_problem" },
        [
          {
            id: "disabled-finance",
            enabled: false,
            order: 1,
            conditions: { categories: ["payment_problem"] },
            action: { assignTeam: "finance" },
          },
          {
            id: "fallback",
            order: 999,
            conditions: {},
            action: { assignTeam: "shared-inbox" },
          },
        ],
      ),
    ).toMatchObject({
      matchedRuleId: "fallback",
      assignedTeam: "shared-inbox",
    });
  });

  it("does not mutate the persisted rule order while evaluating", () => {
    const rules: RoutingRule[] = [
      { id: "later", order: 20, action: {} },
      { id: "first", order: 10, action: {} },
    ];

    expect(routeConversation({}, rules)?.matchedRuleId).toBe("first");
    expect(rules.map((rule) => rule.id)).toEqual(["later", "first"]);
  });

  it("returns null when no assignment or fallback rule matches", () => {
    expect(
      routeConversation(
        { category: "booking_change" },
        [
          {
            id: "firing-only",
            conditions: { categories: ["firing_question"] },
            action: { assignTeam: "firing" },
          },
        ],
      ),
    ).toBeNull();
  });
});
