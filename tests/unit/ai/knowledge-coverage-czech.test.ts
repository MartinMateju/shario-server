import { describe, expect, it } from "vitest";

import { CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS } from "@/modules/ai/ai-evaluation.catalog.js";
import {
  articleCoversQuestion,
  evaluateKnowledgeCoverageDocuments,
  isAnswerBearingCoverageText,
} from "@/modules/ai/services/knowledge-coverage-evaluator.js";
import customerAnswers from "./knowledge-coverage-czech.fixture.json" with { type: "json" };

// Anonymized factual equivalents of natural customer-facing Czech answers;
// deliberately independent of the catalog's synthetic representativeAnswer.
describe("Czech customer knowledge coverage", () => {
  it.each(customerAnswers)(
    "recognizes the factual $id answer",
    ({ id, question: topicText, answer: answerText }) => {
      const question = CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.find(
        (entry) => entry.id === id,
      )!;
      expect(
        articleCoversQuestion({
          topicText,
          answerText,
          question,
          locale: "cs",
        }),
      ).toBe(true);
    },
  );

  it("allows one FAQ resource to cover all eight questions", () => {
    expect(
      evaluateKnowledgeCoverageDocuments({
        documents: customerAnswers.map(({ question, answer }) => ({
          topicText: question,
          answerText: answer,
        })),
        locale: "cs",
      }),
    ).toMatchObject({
      answeredCount: 8,
      totalCount: 8,
      score: 100,
      warnings: [],
      complete: true,
    });
  });

  it.each([
    "",
    "Připravujeme, bude doplněno.",
    "Nemůžeme potvrdit pravidla, kontaktuj studio.",
    "Nevím, zda můžeš změnit termín rezervace online.",
    "Nemůžu potvrdit, že do týdne dostaneš e-mail po výpalu výrobku.",
    "V ateliéru dostaneš novinky o příští výstavě.",
  ])(
    "does not turn a complete topic/question into evidence from a non-answer: %j",
    (answerText) => {
      const documents = customerAnswers.map(({ question }) => ({
        topicText: question,
        answerText,
      }));
      expect(
        evaluateKnowledgeCoverageDocuments({ documents, locale: "cs" })
          .answeredCount,
      ).toBe(0);
    },
  );

  it("does not count the questions themselves as answers", () => {
    const documents = customerAnswers.map(({ question }) => ({
      topicText: question,
      answerText: question,
    }));
    expect(
      evaluateKnowledgeCoverageDocuments({ documents, locale: "cs" })
        .answeredCount,
    ).toBe(0);
  });

  it.each([
    ["booking_reschedule", "Termín rezervace můžeš změnit online."],
    ["booking_reschedule", "Termín rezervace můžete změnit online."],
    ["course_preparation", "Nemusíte si přinést vůbec nic na kurz."],
    ["membership_usage", "V nabídce nejsou nové plány placeného členství."],
    ["membership_usage", "Nové členské plány nenabízíme."],
    ["accessibility", "Studio má bezbariérový vstup i toaletu."],
  ])(
    "recognizes equivalent formal/informal factual wording for %s",
    (id, answerText) => {
      const question = CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.find(
        (entry) => entry.id === id,
      )!;
      expect(
        articleCoversQuestion({
          topicText: question.question.cs,
          answerText,
          question,
          locale: "cs",
        }),
      ).toBe(true);
    },
  );

  it.each([
    "Termín rezervace můžeš změnit online, ale termín rezervace nemůžeš změnit online.",
    "Na kurz musíš přinést vlastní zástěru, ale na kurz nemusíš přinést vlastní zástěru.",
    "Studio má bezbariérový vstup, ale studio nemá bezbariérový vstup.",
    "Členské plány nabízíme, ale členské plány nenabízíme.",
  ])(
    "rejects contradictions in the newly supported informal/factual forms: %s",
    (answerText) => {
      expect(isAnswerBearingCoverageText(answerText, "cs")).toBe(false);
    },
  );

  it.each([
    ["studio_inclusions", "Materiál, nástroje, výpaly a hlína."],
    ["studio_arrival", "Příchod, vstupní kód, e-mail a rezervace."],
    ["membership_usage", "Členství, nové plány, kredit a obnova."],
    ["accessibility", "Bezbariérový vstup, studio a pohyblivost."],
  ])("still rejects a Czech keyword list for %s", (id, answerText) => {
    const question = CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.find(
      (entry) => entry.id === id,
    )!;
    expect(
      articleCoversQuestion({
        topicText: question.question.cs,
        answerText,
        question,
        locale: "cs",
      }),
    ).toBe(false);
  });
});
