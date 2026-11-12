export type AssistantFeedbackRegressionCase = {
  id: string;
  category: "feedback" | "multi_turn" | "proactivity";
  locale: "cs" | "en";
  history: Array<{ role: "assistant" | "user"; content: string }>;
  question: string;
  expectedIntent: string;
  expectedAnswerSignals: readonly string[];
  forbiddenAnswerSignals: readonly string[];
  expectedSuggestedReplies?: readonly string[];
  orderedAnswerSignals?: readonly string[];
};

const EN_DEAD_ENDS = [
  "I’m missing the workspace context",
  "What are you trying to decide",
  "I don’t have enough information",
] as const;

const CS_DEAD_ENDS = [
  "Nemám dostatek informací",
  "Upřesněte prosím otázku",
  "Chybí mi kontext",
] as const;

/**
 * Synthetic, privacy-reviewed cases promoted from repeated product feedback
 * patterns. Production prompts and answers must never be copied here by the
 * exporter. Every entry is executed in offline CI.
 */
export const ASSISTANT_FEEDBACK_REGRESSION_CASES: readonly AssistantFeedbackRegressionCase[] =
  [
    {
      id: "feedback_en_ambiguous_booking_period",
      category: "feedback",
      locale: "en",
      history: [],
      question: "How many bookings do I have?",
      expectedIntent: "booking_overview",
      expectedAnswerSignals: ["Which booking period do you mean", "all time"],
      forbiddenAnswerSignals: EN_DEAD_ENDS,
      expectedSuggestedReplies: ["Today", "Upcoming", "All time"],
    },
    {
      id: "feedback_cs_ambiguous_booking_period",
      category: "feedback",
      locale: "cs",
      history: [],
      question: "Kolik rezervací mám?",
      expectedIntent: "booking_overview",
      expectedAnswerSignals: ["Jaké období rezervací myslíte", "za celou dobu"],
      forbiddenAnswerSignals: CS_DEAD_ENDS,
      expectedSuggestedReplies: ["Dnes", "Budoucí", "Za celou dobu"],
    },
    {
      id: "multi_turn_en_booking_period_follow_up",
      category: "multi_turn",
      locale: "en",
      history: [
        { role: "user", content: "How many bookings do I have?" },
        {
          role: "assistant",
          content: "Which booking period do you mean: today, upcoming, or all time?",
        },
      ],
      question: "Upcoming",
      expectedIntent: "future_bookings",
      expectedAnswerSignals: ["9 upcoming confirmed bookings", "Open studio"],
      forbiddenAnswerSignals: EN_DEAD_ENDS,
    },
    {
      id: "multi_turn_cs_booking_period_follow_up",
      category: "multi_turn",
      locale: "cs",
      history: [
        { role: "user", content: "Kolik rezervací mám?" },
        {
          role: "assistant",
          content: "Jaké období rezervací myslíte: dnes, budoucí, nebo za celou dobu?",
        },
      ],
      question: "Za celou dobu",
      expectedIntent: "all_time_bookings",
      expectedAnswerSignals: ["21 potvrzených rezervací", "za celou dobu"],
      forbiddenAnswerSignals: CS_DEAD_ENDS,
    },
    {
      id: "multi_turn_en_staff_blocker_follow_up",
      category: "multi_turn",
      locale: "en",
      history: [
        { role: "user", content: "Are there any blockers today?" },
        {
          role: "assistant",
          content: "Yes — I found possible blockers today.",
        },
      ],
      question: "What about my team?",
      expectedIntent: "staff_blockers",
      expectedAnswerSignals: [
        "team member reports a blocker",
        "Waiting for equipment repair approval",
      ],
      forbiddenAnswerSignals: EN_DEAD_ENDS,
    },
    {
      id: "multi_turn_cs_staff_blocker_follow_up",
      category: "multi_turn",
      locale: "cs",
      history: [
        { role: "user", content: "Máme dnes nějaké problémy?" },
        {
          role: "assistant",
          content: "Ano — dnes jsem našel možné blokace.",
        },
      ],
      question: "A co náš tým?",
      expectedIntent: "staff_blockers",
      expectedAnswerSignals: [
        "člen týmu hlásí blokaci",
        "Čeká na schválení opravy pece",
      ],
      forbiddenAnswerSignals: CS_DEAD_ENDS,
    },
    {
      id: "proactivity_en_rank_verified_priorities",
      category: "proactivity",
      locale: "en",
      history: [],
      question: "What should I focus on today?",
      expectedIntent: "daily_priorities",
      expectedAnswerSignals: ["I’d focus on these in order", "need attention"],
      forbiddenAnswerSignals: EN_DEAD_ENDS,
      orderedAnswerSignals: [
        "Urgent customer messages",
        "Overdue studio tasks",
        "Staff blockers",
      ],
    },
    {
      id: "proactivity_cs_rank_verified_priorities",
      category: "proactivity",
      locale: "cs",
      history: [],
      question: "Na co se mám dnes zaměřit?",
      expectedIntent: "daily_priorities",
      expectedAnswerSignals: [
        "Zaměřil bych se na tyto věci v tomto pořadí",
        "vyžaduje pozornost",
      ],
      forbiddenAnswerSignals: CS_DEAD_ENDS,
      orderedAnswerSignals: [
        "Naléhavé zprávy zákazníků",
        "Zpožděné úkoly týmu",
        "Blokace týmu",
      ],
    },
  ] as const;
