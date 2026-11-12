import { describe, expect, it } from "vitest";

import { ASSISTANT_FEEDBACK_REGRESSION_CASES } from "@/modules/ai/ai-feedback-regression.catalog.js";
import {
  buildFeedbackRegressionReport,
  createFeedbackPattern,
  redactFeedbackText,
} from "@/modules/ai/services/feedback-regression.service.js";
import {
  getWorkspaceFactFallback,
  resolveWorkspaceFactIntent,
} from "@/modules/ai/services/assistant.service.js";

const operationsFixture = {
  scope: { dateKey: "2026-08-13", timezone: "Europe/Prague" },
  operations: {
    coverage: {
      available: [
        "bookings",
        "tasks",
        "staffPlanning",
        "inventory",
        "firings",
        "communications",
      ],
      unavailable: [],
      complete: true,
    },
    bookings: {
      todayCount: 4,
      futureConfirmedCount: 9,
      allTimeConfirmedCount: 21,
      upcoming: [
        { name: "Open studio", start: "2026-08-13T16:00:00.000Z" },
      ],
    },
    tasks: { openCount: 5, overdueCount: 1, urgent: 2 },
    staffPlanning: {
      counts: { blocked: 1, missing: 0, needsOwnerAttention: 0 },
      today: {
        staff: {
          total: 1,
          items: [
            {
              displayName: "Maya",
              update: {
                blockers: {
                  en: "Waiting for equipment repair approval.",
                  cs: "Čeká na schválení opravy pece.",
                },
              },
            },
          ],
          truncated: false,
        },
      },
    },
    inventory: { lowStockCount: 0 },
    firings: {
      running: 1,
      pending: 0,
      completedAwaitingNotification: 0,
    },
    communications: { open: 2, urgent: 1, unread: 2 },
  },
};

const localizedFacts = (locale: "cs" | "en") => {
  const cloned = structuredClone(operationsFixture);
  const blocker = cloned.operations.staffPlanning.today.staff.items[0]!.update
    .blockers as unknown as Record<"cs" | "en", string>;
  cloned.operations.staffPlanning.today.staff.items[0]!.update.blockers =
    blocker[locale] as never;
  return cloned;
};

describe("feedback-derived assistant regressions", () => {
  it.each(ASSISTANT_FEEDBACK_REGRESSION_CASES)(
    "keeps $id responsive, localized and grounded",
    (evaluation) => {
      const intent = resolveWorkspaceFactIntent({
        question: evaluation.question,
        history: evaluation.history,
      });
      expect(intent).toBe(evaluation.expectedIntent);

      const result = getWorkspaceFactFallback({
        question: evaluation.question,
        locale: evaluation.locale,
        facts: localizedFacts(evaluation.locale),
        intentOverride: intent || undefined,
      });

      expect(result).toMatchObject({
        grounding: {
          basis: "workspace_facts",
          insufficientEvidence: false,
        },
      });
      for (const signal of evaluation.expectedAnswerSignals) {
        expect(result?.answer).toContain(signal);
      }
      for (const signal of evaluation.forbiddenAnswerSignals) {
        expect(result?.answer).not.toContain(signal);
      }
      if (evaluation.expectedSuggestedReplies) {
        expect(result?.suggestedReplies).toEqual(
          evaluation.expectedSuggestedReplies,
        );
      }
      if (evaluation.orderedAnswerSignals) {
        const positions = evaluation.orderedAnswerSignals.map((signal) =>
          String(result?.answer || "").indexOf(signal),
        );
        positions.forEach((position) => expect(position).toBeGreaterThan(-1));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }
    },
  );
});

describe("feedback regression report privacy", () => {
  const tenantId = "507f1f77bcf86cd799439011";
  const observations = [
    {
      tenantId,
      locale: "en",
      prompt: "Please tell me how many bookings I have for jane@example.com",
      answer: "Jane has 3 bookings. Call +420 605 123 456.",
      createdAt: "2026-08-12T10:00:00.000Z",
      promptVersion: "studio-assistant-v13",
      model: "gpt-test",
      provider: "openai",
      groundingStatus: "workspace_facts",
    },
    {
      tenantId,
      locale: "en",
      prompt: "How many bookings do I have for john@example.com?",
      answer: "John has 2 bookings. See https://example.com/customer/42.",
      createdAt: "2026-08-13T10:00:00.000Z",
      promptVersion: "studio-assistant-v13",
      model: "gpt-test",
      provider: "openai",
      groundingStatus: "workspace_facts",
    },
    {
      tenantId: "507f1f77bcf86cd799439099",
      locale: "en",
      prompt: "How many bookings do I have?",
      answer: "Private cross-tenant answer",
      createdAt: "2026-08-13T11:00:00.000Z",
    },
  ];

  it("groups repeated patterns without exposing production text by default", () => {
    const report = buildFeedbackRegressionReport({
      tenantId,
      observations,
      minimumOccurrences: 2,
      generatedAt: new Date("2026-08-13T12:00:00.000Z"),
    });

    expect(report.summary).toMatchObject({
      suppliedObservations: 3,
      tenantMatchedObservations: 2,
      eligibleObservations: 2,
      repeatedCandidateCount: 1,
    });
    expect(report.candidates[0]).toMatchObject({
      occurrences: 2,
      locale: "en",
      promptVersions: ["studio-assistant-v13"],
    });
    expect(report.candidates[0]).not.toHaveProperty("samples");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("john@example.com");
    expect(serialized).not.toContain("605 123 456");
    expect(serialized).not.toContain("Private cross-tenant answer");
    expect(serialized).not.toContain(tenantId);
  });

  it("redacts opted-in local samples and never lowers the repetition floor", () => {
    const report = buildFeedbackRegressionReport({
      tenantId,
      observations,
      minimumOccurrences: 2,
      includeRedactedText: true,
    });
    const serialized = JSON.stringify(report.candidates[0]?.samples);
    expect(serialized).toContain("[email]");
    expect(serialized).toContain("[phone]");
    expect(serialized).toContain("[url]");
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("605 123 456");
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("John");
    expect(() =>
      buildFeedbackRegressionReport({
        tenantId,
        observations,
        minimumOccurrences: 1,
      }),
    ).toThrow("at least 2");
  });

  it("normalizes equivalent wording while keeping locale in the fingerprint", () => {
    const first = createFeedbackPattern({
      locale: "en",
      prompt: "Please tell me how many bookings I have",
    });
    const second = createFeedbackPattern({
      locale: "en",
      prompt: "How many bookings do I have?",
    });
    const czech = createFeedbackPattern({
      locale: "cs",
      prompt: "Kolik mám rezervací?",
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(czech.fingerprint).not.toBe(first.fingerprint);
    expect(redactFeedbackText("mail a@example.com at 9:00")).toBe(
      "mail [email] at [time]",
    );
  });
});
