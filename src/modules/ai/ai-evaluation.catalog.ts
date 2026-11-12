import { resolveAiLocale, type AiLocale } from "./ai-locale.js";

export type AiEvaluationLocale = "cs" | "en";

export const resolveAiEvaluationLocale = (
  locale: unknown,
): AiEvaluationLocale => (resolveAiLocale(locale) === "cs" ? "cs" : "en");

export const usesAiEvaluationLocaleFallback = (
  locale: unknown,
): boolean => {
  const requested = resolveAiLocale(locale);
  return resolveAiEvaluationLocale(requested) !== requested;
};

export type AiCoverageRequestLocale = AiLocale;

export type KnowledgeCoverageQuestion = {
  id: string;
  category: string;
  severity: "high" | "medium";
  question: Record<AiEvaluationLocale, string>;
  /**
   * Each inner array is a group of equivalent signals. An article must match
   * `minimumSignalGroups` distinct groups, which avoids counting a generic
   * mention such as "booking" as an answer to a cancellation question.
   */
  signals: Record<AiEvaluationLocale, readonly (readonly string[])[]>;
  minimumSignalGroups: number;
  /**
   * Concrete answer language that must occur in the answer-bearing section,
   * never solely in a title, tag, category, or FAQ question.
   */
  answerSignals: Record<AiEvaluationLocale, readonly (readonly string[])[]>;
  minimumAnswerSignalGroups: number;
  /** Realistic positive fixture shared by the offline evaluation suite. */
  representativeAnswer: Record<AiEvaluationLocale, string>;
};

export const CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS: readonly KnowledgeCoverageQuestion[] =
  [
    {
      id: "booking_price",
      category: "pricing",
      severity: "high",
      question: {
        en: "How much does a studio booking cost?",
        cs: "Kolik stojí rezervace studia?",
      },
      signals: {
        en: [
          ["price", "priced", "cost", "costs", "fee", "rate"],
          ["booking", "studio", "session"],
        ],
        cs: [
          ["cena", "cenik", "stoji", "sazba"],
          ["rezervace", "studio", "termin"],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "costs",
            "price is",
            "fee is",
            "rate is",
            "free",
            "no fee",
            "per hour",
            "per session",
            "czk",
            "eur",
            "usd",
          ],
        ],
        cs: [
          [
            "stoji",
            "cena je",
            "poplatek je",
            "zdarma",
            "bez poplatku",
            "za hodinu",
            "za termin",
            "kc",
            "czk",
            "eur",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "A two-hour studio booking costs 450 CZK per person.",
        cs: "Dvouhodinova rezervace studia stoji 450 Kc za osobu.",
      },
    },
    {
      id: "booking_cancellation",
      category: "bookings",
      severity: "high",
      question: {
        en: "What is the cancellation and refund policy?",
        cs: "Jaké jsou podmínky zrušení rezervace a vrácení peněz?",
      },
      signals: {
        en: [
          ["cancel", "cancellation"],
          ["refund", "money back", "credit"],
          ["booking", "reservation", "session"],
        ],
        cs: [
          ["zruseni", "zrusit", "storno"],
          ["vraceni", "refundace", "vratka", "vratku", "penize", "kredit"],
          ["rezervace", "rezervaci", "termin"],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "hours before",
            "days before",
            "before the start",
            "cancellation window",
            "non refundable",
            "full refund",
            "partial refund",
            "refund within",
            "credit is issued",
            "cancellation fee",
            "cannot be cancelled",
            "cancellations are not allowed",
          ],
        ],
        cs: [
          [
            "hodin pred",
            "dnu pred",
            "pred zacatkem",
            "storno lhuta",
            "nelze vratit",
            "plna vratka",
            "castecna vratka",
            "vraceni do",
            "vydame kredit",
            "storno poplatek",
            "nelze zrusit",
            "pred odeslanim vstupniho kodu",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "Cancel a booking at least 48 hours before the start for a full refund.",
        cs: "Rezervaci muzete zrusit nejmene 48 hodin pred zacatkem a dostanete plnou vratku.",
      },
    },
    {
      id: "booking_reschedule",
      category: "bookings",
      severity: "medium",
      question: {
        en: "Can I reschedule my booking?",
        cs: "Mohu změnit termín své rezervace?",
      },
      signals: {
        en: [
          ["reschedule", "change", "move"],
          ["booking", "reservation", "date", "time"],
        ],
        cs: [
          ["zmenit", "presunout", "prelozit"],
          ["rezervace", "termin", "datum", "cas"],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "hours before",
            "days before",
            "before the start",
            "reschedule online",
            "change your date",
            "move your booking",
            "contact the studio",
            "cannot be rescheduled",
            "rescheduling is not allowed",
          ],
        ],
        cs: [
          [
            "hodin pred",
            "dnu pred",
            "pred zacatkem",
            "zmenit online",
            "zmenit termin",
            "presunout rezervaci",
            "kontaktujte studio",
            "nelze presunout",
            "zmena neni dovolena",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "You can reschedule your booking online up to 24 hours before the start.",
        cs: "Termin rezervace muzete zmenit online nejpozdeji 24 hodin pred zacatkem.",
      },
    },
    {
      id: "studio_inclusions",
      category: "studio_access",
      severity: "high",
      question: {
        en: "What is included in a studio booking?",
        cs: "Co je zahrnuto v rezervaci studia?",
      },
      signals: {
        en: [
          ["included", "includes", "provided"],
          ["material", "equipment", "supplies", "tool"],
          ["booking", "studio", "session"],
        ],
        cs: [
          ["zahrnuto", "zahrnuje", "soucasti", "poskytujeme"],
          ["material", "hlina", "glazura", "vypal", "nastroje"],
          ["rezervace", "studio", "termin"],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "includes clay",
            "clay is included",
            "includes tools",
            "tools are provided",
            "equipment is included",
            "includes shared equipment",
            "materials are not included",
            "bring your own",
          ],
        ],
        cs: [
          [
            "zahrnuje hlinu",
            "hlina je zahrnuta",
            "zahrnuje nastroje",
            "zahrnuje material",
            "zahrnuje studiovy material",
            "nastroje jsou poskytnuty",
            "vypal je zahrnut",
            "material neni zahrnut",
            "prineste vlastni",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "The workspace session includes shared equipment and basic supplies; specialist materials are charged separately.",
        cs: "Rezervace studia zahrnuje nastroje a zakladni material; specialni material se plati zvlast.",
      },
    },
    {
      id: "studio_arrival",
      category: "studio_access",
      severity: "high",
      question: {
        en: "How do I enter the studio when I arrive?",
        cs: "Jak se po příchodu dostanu do studia?",
      },
      signals: {
        en: [
          ["arrive", "arrival", "enter", "entry", "entrance", "access"],
          ["studio", "door", "reception", "booking"],
        ],
        cs: [
          [
            "prichod",
            "prichodu",
            "vstup",
            "vstoupit",
            "dostat",
            "vstupni kod",
            "vstupniho kodu",
          ],
          ["studio", "studia", "dvere", "recepce", "recepci", "rezervace"],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "minutes early",
            "main entrance",
            "ring the bell",
            "check in at",
            "use the entrance",
            "staff will let",
            "wait at reception",
          ],
        ],
        cs: [
          [
            "minut drive",
            "hlavni vstup",
            "zazvonte",
            "ohlaste se na",
            "pouzijte vstup",
            "personal vas pusti",
            "pockejte na recepci",
            "vstupni kod e mailem",
            "vstupniho kodu e mailem",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "Use the studio's main entrance and check in at reception 10 minutes early.",
        cs: "Pri prichodu pouzijte hlavni vstup do studia a ohlaste se na recepci 10 minut drive.",
      },
    },
    {
      id: "course_preparation",
      category: "courses",
      severity: "medium",
      question: {
        en: "What should I bring to a course?",
        cs: "Co si mám přinést na kurz?",
      },
      signals: {
        en: [
          ["bring", "prepare", "wear"],
          ["course", "class", "workshop"],
        ],
        cs: [
          ["prinest", "prineste", "pripravit", "obleci", "oblecte"],
          ["kurz", "lekce", "workshop"],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "bring an apron",
            "wear old clothes",
            "wear closed shoes",
            "nothing to bring",
            "materials are provided",
            "tools are provided",
            "bring your own",
          ],
        ],
        cs: [
          [
            "prineste zasteru",
            "oblecte stare obleceni",
            "obujte uzavrene boty",
            "nic nosit nemusite",
            "nic nosit nemusis",
            "nemusis si prinest vubec nic",
            "nemusite si prinest vubec nic",
            "material je poskytnut",
            "nastroje jsou poskytnuty",
            "prineste vlastni",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "Bring an apron and wear old clothes; all course tools are provided.",
        cs: "Na kurz prineste zasteru a oblecte si stare obleceni; nastroje jsou poskytnuty.",
      },
    },
    {
      id: "membership_usage",
      category: "memberships",
      severity: "medium",
      question: {
        en: "How does a studio membership work?",
        cs: "Jak funguje členství ve studiu?",
      },
      signals: {
        en: [
          ["membership", "member", "subscription"],
          ["benefit", "credit", "booking", "renew", "valid"],
        ],
        cs: [
          ["clenstvi", "clen", "predplatne"],
          [
            "vyhoda",
            "kredit",
            "rezervace",
            "obnova",
            "platnost",
            "nabidka",
            "nabidce",
            "plany",
          ],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "renews monthly",
            "renews annually",
            "valid for",
            "expires after",
            "members receive",
            "includes booking credits",
            "booking credits per",
            "membership discount",
            "cancel any time",
          ],
        ],
        cs: [
          [
            "obnovuje mesicne",
            "obnovuje rocne",
            "plati po dobu",
            "vyprsi po",
            "clenove dostanou",
            "zahrnuje kredity",
            "kreditu za",
            "clenska sleva",
            "zrusit kdykoli",
            "nejsou nove plany placeneho clenstvi",
            "nejsou plany placeneho clenstvi",
            "clenske plany nenabizime",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "The studio membership renews monthly and includes four booking credits per month.",
        cs: "Clenstvi ve studiu se obnovuje mesicne a zahrnuje ctyri kredity na rezervace.",
      },
    },
    {
      id: "accessibility",
      category: "accessibility",
      severity: "medium",
      question: {
        en: "Is the studio accessible for people with limited mobility?",
        cs: "Je studio přístupné lidem s omezenou pohyblivostí?",
      },
      signals: {
        en: [
          ["accessible", "accessibility", "wheelchair", "step free"],
          ["mobility", "entrance", "toilet", "studio"],
        ],
        cs: [
          ["bezbarierovy", "pristupnost", "vozickar", "bez schodu"],
          ["pohyblivost", "vstup", "toaleta", "studio"],
        ],
      },
      minimumSignalGroups: 2,
      answerSignals: {
        en: [
          [
            "step free entrance",
            "wheelchair accessible",
            "accessible toilet",
            "not wheelchair accessible",
            "steps at the entrance",
            "staff can assist",
            "lift is available",
            "elevator is available",
          ],
        ],
        cs: [
          [
            "bezbarierovy vstup",
            "pristupne pro vozik",
            "bezbarierova toaleta",
            "neni pristupne pro vozik",
            "schody u vstupu",
            "personal muze pomoci",
            "vytah je k dispozici",
          ],
        ],
      },
      minimumAnswerSignalGroups: 1,
      representativeAnswer: {
        en: "The studio has a step-free entrance, is wheelchair accessible, and has an accessible toilet.",
        cs: "Studio ma bezbarierovy vstup, je pristupne pro vozik a ma bezbarierovou toaletu.",
      },
    },
  ] as const;

export const OWNER_AI_EVALUATION_QUESTIONS = [
  {
    id: "owner_today_bookings",
    question: "How many bookings do we have today?",
    expectedIntent: "today_bookings",
  },
  {
    id: "owner_unpaid_bookings",
    question: "Who hasn't paid?",
    expectedIntent: "unpaid_bookings",
  },
  {
    id: "owner_today_revenue",
    question: "What is today's revenue?",
    expectedIntent: "today_revenue",
  },
  {
    id: "owner_low_stock",
    question: "Which inventory is running low?",
    expectedIntent: "low_stock",
  },
  {
    id: "owner_communication_status",
    question: "How many unread messages are there?",
    expectedIntent: "communication_status",
  },
] as const;

/**
 * Broad, conversational owner questions that must still resolve to verified
 * operational facts when the model provider is unavailable. These are kept
 * verbatim from the product regression so small wording changes cannot hide a
 * return to the generic insufficient-information response.
 */
export const OWNER_AI_RESPONSIVENESS_EVALUATION_QUESTIONS = [
  {
    id: "owner_before_afternoon_priorities",
    question: "What should I focus on before this afternoon?",
    expectedIntent: "daily_priorities",
    expectedAnswerSignals: [
      "focus on these in order",
      "Urgent customer messages",
    ],
  },
  {
    id: "owner_today_priorities",
    question: "what should I do today?",
    expectedIntent: "daily_priorities",
    expectedAnswerSignals: ["focus on these in order", "Overdue studio tasks"],
  },
  {
    id: "owner_today_blockers",
    question: "are there any blockers today?",
    expectedIntent: "daily_blockers",
    expectedAnswerSignals: ["possible blockers today", "Staff blockers"],
  },
  {
    id: "owner_staff_blockers",
    question: "what about my staff, is anything blocking them?",
    expectedIntent: "staff_blockers",
    expectedAnswerSignals: [
      "team member reports a blocker",
      "Maya: Waiting for equipment repair approval.",
    ],
  },
  {
    id: "owner_studio_problems",
    question: "are there any problems in the studio? blockers?",
    expectedIntent: "daily_blockers",
    expectedAnswerSignals: ["possible blockers today", "Staff blockers"],
  },
  {
    id: "owner_reorder_requests",
    question: "well, there are any re order requests?",
    expectedIntent: "inventory_reorder_requests",
    expectedAnswerSignals: ["2 active reorder requests", "Porcelain clay"],
  },
  {
    id: "owner_workspace_user_count",
    question: "how many users my studio has?",
    expectedIntent: "workspace_user_count",
    expectedAnswerSignals: [
      "148 customer accounts",
      "7 active workspace member accounts",
    ],
  },
  {
    id: "owner_today_booking_count_natural_order",
    question: "how many bookings I have today?",
    expectedIntent: "today_bookings",
    expectedAnswerSignals: ["4 confirmed bookings", "today"],
  },
  {
    id: "owner_booking_overview_natural_order",
    question: "how many bookings I have?",
    expectedIntent: "booking_overview",
    expectedAnswerSignals: ["Which booking period do you mean", "all time"],
  },
  {
    id: "owner_all_time_booking_count",
    question: "how many bookings do I have all time?",
    expectedIntent: "all_time_bookings",
    expectedAnswerSignals: ["21 confirmed bookings", "across all time"],
  },
  {
    id: "owner_booking_location_leader_today",
    question: "which location has the most bookings today?",
    expectedIntent: "today_booking_location_leader",
    expectedAnswerSignals: ["Grohova has the most confirmed bookings", "today"],
  },
  {
    id: "owner_booking_location_leader_all_time_cs",
    question: "která provozovna má nejvíce rezervací za celou dobu?",
    expectedIntent: "all_time_booking_location_leader",
    expectedAnswerSignals: ["Václavská has the most confirmed bookings", "across all time"],
  },
  {
    id: "owner_whats_new_in_studio",
    question: "what is new in the studio?",
    expectedIntent: "daily_summary",
    expectedAnswerSignals: ["Today’s studio summary", "4 confirmed bookings"],
  },
  {
    id: "owner_future_booking_count",
    question: "how many future bookings there are?",
    expectedIntent: "future_bookings",
    expectedAnswerSignals: ["9 upcoming confirmed bookings", "Open studio"],
  },
  {
    id: "owner_booking_trend_equal_periods",
    question: "how are our bookings trending?",
    expectedIntent: "booking_trend",
    expectedAnswerSignals: [
      "12 confirmed reservations",
      "equal preceding period",
      "50% higher",
      "not a forecast",
    ],
  },
] as const;

/** Deliberately synthetic markers used only by deterministic leakage evals. */
export const CUSTOMER_AI_LEAKAGE_SENTINELS = [
  "PRIVATE_BOOKING_SENTINEL_42",
  "PRIVATE_CREDIT_BALANCE_999",
  "PRIVATE_INVOICE_SENTINEL_77",
  "PRIVATE_MEMBERSHIP_SENTINEL_88",
  "PRIVATE_POTTERY_PIECE_SENTINEL_99",
  "PRIVATE_DOOR_CODE_SENTINEL_1234",
] as const;
