import { describe, expect, it } from "vitest";

import { buildDailyBriefingOperationsInbox } from "@/modules/ai/services/briefing-snapshot.service.js";

const attentionItem = (index: number, href: string | null = null) => ({
  id: `attention-${index}`,
  key: `metric_${index}`,
  severity: index === 0 ? ("critical" as const) : ("warning" as const),
  metricKey: "openTasks" as const,
  value: index,
  title: `Item ${index}`,
  description: `Verified item ${index} needs review.`,
  href,
});

describe("daily briefing Operations Inbox", () => {
  it("derives a bounded, read-only response from allowlisted attention rows", () => {
    const attention = Array.from({ length: 12 }, (_, index) =>
      attentionItem(index, index === 0 ? "/app/tasks?filter=urgent" : null),
    );
    const result = buildDailyBriefingOperationsInbox({
      attention,
      suggestedActions: [
        {
          id: "open-attention-1",
          kind: "navigate",
          label: "Open",
          intent: null,
          href: "/app/tasks",
          attentionId: "attention-1",
        },
        {
          id: "forged",
          kind: "assistant_intent",
          label: "Do it",
          intent: "delete-everything",
          href: "/app/admin",
          attentionId: "not-in-attention",
        },
      ],
      locale: "en",
    });

    expect(result).toHaveLength(10);
    expect(result.map(({ id }) => id)).toEqual(
      attention.slice(0, 10).map(({ id }) => id),
    );
    expect(result[0]).toEqual({
      id: "attention-0",
      type: "metric_0",
      severity: "critical",
      title: "Item 0",
      description: "Verified item 0 needs review.",
      prompt:
        "Help me resolve this verified studio item: Verified item 0 needs review.",
      href: "/app/tasks?filter=urgent",
    });
    expect(result[1].href).toBe("/app/tasks");
    expect(result.some(({ id }) => id === "not-in-attention")).toBe(false);
    for (const item of result) {
      expect(item).not.toHaveProperty("kind");
      expect(item).not.toHaveProperty("intent");
      expect(item).not.toHaveProperty("action");
    }
  });

  it("fails closed on external navigation and keeps prompts server-authored", () => {
    const result = buildDailyBriefingOperationsInbox({
      attention: [attentionItem(0, "https://evil.example/collect")],
      suggestedActions: [
        {
          id: "external",
          kind: "navigate",
          label: "Open",
          intent: null,
          href: "//evil.example/collect",
          attentionId: "attention-0",
        },
      ],
      locale: "en",
    });
    expect(result[0].href).toBeNull();
    expect(result[0].prompt).toBe(
      "Help me resolve this verified studio item: Verified item 0 needs review.",
    );
  });

  it("bounds every free-text response field", () => {
    const item = {
      ...attentionItem(0),
      id: "i".repeat(150),
      key: "k".repeat(150),
      title: "t".repeat(400),
      description: "d".repeat(2_000),
    };
    const [result] = buildDailyBriefingOperationsInbox({
      attention: [item],
      suggestedActions: [],
      locale: "en",
    });
    expect(result.id).toHaveLength(100);
    expect(result.type).toHaveLength(100);
    expect(result.title).toHaveLength(300);
    expect(result.description).toHaveLength(1_000);
    expect(result.prompt).toHaveLength(500);
  });

  it("localizes the fixed Ask AI prompt without provider prose", () => {
    const result = buildDailyBriefingOperationsInbox({
      attention: [attentionItem(0)],
      suggestedActions: [],
      locale: "cs",
    });
    expect(result[0].prompt).toBe(
      "Pomoz mi vyřešit tuto ověřenou provozní položku: Verified item 0 needs review.",
    );
  });
});
