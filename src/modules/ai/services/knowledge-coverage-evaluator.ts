import {
  CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS,
  type AiEvaluationLocale,
  type KnowledgeCoverageQuestion,
} from "../ai-evaluation.catalog.js";
import type { AiLocale } from "../ai-locale.js";

export type KnowledgeCoverageWarning = {
  id: string;
  code: "knowledge_gap";
  question: string;
  category: string;
  severity: "high" | "medium";
};

export type KnowledgeCoverageHealth = {
  requestedLocale: AiLocale;
  evaluationLocale: AiEvaluationLocale;
  localeFallback: boolean;
  generatedAt: string;
  score: number;
  answeredCount: number;
  totalCount: number;
  warnings: KnowledgeCoverageWarning[];
  /** False when the database scan hit its safety cap. */
  complete: boolean;
  /** True when one or more otherwise eligible articles were not evaluated. */
  truncated: boolean;
};

/**
 * A body section can provide its own topic context. Curated Q&A keeps the
 * question as topic context, but only the answer is tested for substance.
 */
export type KnowledgeCoverageDocument =
  | string
  | {
      topicText?: string;
      answerText: string;
    };

export const normalizeCoverageText = (value: unknown): string =>
  String(value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const matchesSignal = (text: string, signal: string): boolean => {
  const normalized = normalizeCoverageText(signal);
  return normalized.length > 0 && ` ${text} `.includes(` ${normalized} `);
};

const NON_ANSWER_PATTERNS: Record<AiEvaluationLocale, readonly RegExp[]> = {
  en: [
    /\b(?:tbd|todo|placeholder|unknown)\b/,
    /\b(?:coming soon|check back later|to be (?:added|confirmed|decided|updated))\b/,
    /\b(?:no|not|without) (?:current |verified |specific |useful )?(?:information|details|answer|policy|content)\b/,
    /\b(?:we|i) (?:do not|dont|cannot|cant) (?:know|say|confirm|provide)\b/,
    /\b(?:may or may not|is and is not|are and are not|does and does not|can and cannot)\b/,
    /\b(?:lorem ipsum|sample text|test content)\b/,
  ],
  cs: [
    /\b(?:tbd|todo|placeholder|nezname|neznamy)\b/,
    /\b(?:pripravujeme|bude doplneno|bude potvrzeno|zkuste to pozdeji)\b/,
    /\b(?:zadne|nejsou|neni|bez) (?:aktualni |overene |konkretni )?(?:informace|podrobnosti|odpoved|pravidla|obsah)\b/,
    /\b(?:nevime|nevim|nemuzeme potvrdit|nemuzu potvrdit|nemohu potvrdit|nemuzeme odpovedet|nemuzu odpovedet|nemohu odpovedet|nelze potvrdit)\b/,
    /\b(?:muze a nemusi|je a neni|jsou a nejsou|lze a nelze)\b/,
    /\b(?:lorem ipsum|vzorovy text|testovaci obsah)\b/,
  ],
};

const ANSWER_RELATION_PATTERNS: Record<AiEvaluationLocale, readonly RegExp[]> =
  {
    en: [
      /\b(?:costs?|is priced at|fee is|rate is) (?:free|\d+)/,
      /\b(?:is|are) (?:fully )?(?:included|not included|provided|free|step free|wheelchair accessible|not accessible)\b/,
      /\b(?:includes?|provides?|receives?|renews?|expires?|takes?|lasts?|arrive|enter|use|bring|wear|ring|check in|contact|notify|collect|pick up)\b(?: \w+){1,12}/,
      /\b(?:can|cannot|cant|may|must|should|will|wont) \w+\b/,
      /\b(?:at least|up to|within|before|after) \d+ (?:minutes?|hours?|days?|weeks?|months?)\b/,
      /\b\d+(?:[.,]\d+)? (?:czk|kc|eur|usd|minutes?|hours?|days?|weeks?|months?|credits?)\b/,
      /\b(?:full|partial|no) refund\b/,
      /\b(?:non refundable|not refundable|not allowed|nothing to bring|no fee)\b/,
    ],
    cs: [
      /\b(?:stoji|cini|cena je|poplatek je) (?:zdarma|\d+)/,
      /\b(?:je|jsou) (?:plne )?(?:zahrnuto|zahrnuty|poskytnuto|zdarma|bezbarierove|bezbarierovy|pristupne|nepristupne)\b/,
      // Customer-facing Czech commonly uses the informal singular. It carries
      // the same instruction/evidence as the corresponding formal verb.
      /\b(?:zahrnuje|poskytujeme|obdrzite|dostanete|dostanes|obnovuje|plati|trva|prijdte|prijd|vstupte|pouzijte|pouzij|prineste|prines|oblecte|oblec|zazvonte|zazvon|kontaktujte|kontaktuj|upozornime|vyzvednete|vyzvedni|otevri)\b(?: \w+){1,12}/,
      /\b(?:muzete|muzes|nemuzete|nemuzes|lze|nelze|musite|musis|nemusite|nemusis|meli byste|mel bys|budeme) \w+\b/,
      /\b(?:ma|maji) (?:bezbarierovy vstup|bezbarierovou toaletu|pristupny vstup)\b/,
      /\b(?:nejsou (?:nove )?plany placeneho clenstvi|(?:nove )?clenske plany nenabizime)\b/,
      /\b(?:alespon|nejmene|nejpozdeji|do|pred|po) \d+ (?:minut|hodin|dnu|tydnu|mesicu)\b/,
      /\b\d+(?:[.,]\d+)? (?:czk|kc|eur|minut|hodin|dnu|tydnu|mesicu|kreditu)\b/,
      /\b(?:plna|castecna|zadna) (?:refundace|nahrada|vratka)\b/,
      /\b(?:bez nahrady|nelze vratit|neni dovoleno|nic nosit nemusite|bez poplatku)\b/,
    ],
  };

const CONTRADICTION_CONNECTOR: Record<AiEvaluationLocale, RegExp> = {
  en: /\b(?:but|however|yet)\b/,
  cs: /\b(?:ale|avsak|pritom)\b/,
};

const NEGATION_TOKENS = new Set([
  "no",
  "not",
  "never",
  "cannot",
  "cant",
  "dont",
  "doesnt",
  "isnt",
  "arent",
  "wont",
  "neni",
  "nejsou",
  "nelze",
  "nemuze",
  "nemuzete",
  "nemuzes",
  "nemusis",
  "nemusite",
  "nema",
  "nemaji",
  "nenabizime",
  "nestoji",
  "nezahrnuje",
]);

const NEGATION_ONLY_TOKENS = new Set([
  "no",
  "not",
  "never",
  "dont",
  "doesnt",
  "isnt",
  "arent",
  "wont",
]);

const CONTRADICTION_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "do",
  "does",
  "is",
  "the",
  "to",
  "je",
  "jsou",
  "se",
  "si",
  "to",
]);

const canonicalContradictionToken = (token: string): string => {
  const czechNegation: Record<string, string> = {
    cannot: "can",
    cant: "can",
    neni: "je",
    nejsou: "jsou",
    nelze: "lze",
    nemuze: "muze",
    nemuzete: "muzete",
    nemuzes: "muzes",
    nemusis: "musis",
    nemusite: "musite",
    nema: "ma",
    nemaji: "maji",
    nenabizime: "nabizime",
    nestoji: "stoji",
    nezahrnuje: "zahrnuje",
  };
  return czechNegation[token] ?? token;
};

/** Reject two near-identical clauses that make opposite assertions. */
const hasObviousContradiction = (
  text: string,
  locale: AiEvaluationLocale,
): boolean => {
  const clauses = text.split(CONTRADICTION_CONNECTOR[locale]);
  if (clauses.length < 2) return false;
  for (let index = 1; index < clauses.length; index += 1) {
    const leftTokens = clauses[index - 1]!.trim().split(" ").filter(Boolean);
    const rightTokens = clauses[index]!.trim().split(" ").filter(Boolean);
    const leftNegative = leftTokens.some((token) => NEGATION_TOKENS.has(token));
    const rightNegative = rightTokens.some((token) =>
      NEGATION_TOKENS.has(token),
    );
    if (leftNegative === rightNegative) continue;
    const comparable = (tokens: string[]) =>
      new Set(
        tokens
          .map(canonicalContradictionToken)
          .filter(
            (token) =>
              !NEGATION_ONLY_TOKENS.has(token) &&
              !CONTRADICTION_STOP_WORDS.has(token),
          ),
      );
    const left = comparable(leftTokens);
    const right = comparable(rightTokens);
    const intersection = [...left].filter((token) => right.has(token)).length;
    const union = new Set([...left, ...right]).size;
    if (intersection >= 3 && union > 0 && intersection / union >= 0.75) {
      return true;
    }
  }
  return false;
};

const isQuestionOnly = (raw: string, locale: AiEvaluationLocale): boolean => {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const lastQuestionMark = trimmed.lastIndexOf("?");
  if (
    lastQuestionMark >= 0 &&
    !normalizeCoverageText(trimmed.slice(lastQuestionMark + 1))
  ) {
    return true;
  }
  const normalized = normalizeCoverageText(trimmed);
  const questionPrefix =
    locale === "en"
      ? /^(?:can|could|do|does|how|is|may|should|what|when|where|which|will)\b/
      : /^(?:co|jak|jaka|jake|jaky|je|jsou|kde|kdy|lze|mohu|muzeme|muze|zda)\b/;
  return !/[.!;:]\s*$/u.test(trimmed) && questionPrefix.test(normalized);
};

export const isAnswerBearingCoverageText = (
  value: unknown,
  locale: AiEvaluationLocale,
): boolean => {
  const raw = String(value ?? "").trim();
  const text = normalizeCoverageText(raw);
  if (!text || text.split(" ").length < 4) return false;
  if (isQuestionOnly(raw, locale)) return false;
  if (NON_ANSWER_PATTERNS[locale].some((pattern) => pattern.test(text))) {
    return false;
  }
  if (hasObviousContradiction(text, locale)) return false;
  return ANSWER_RELATION_PATTERNS[locale].some((pattern) => pattern.test(text));
};

export const articleCoversQuestion = ({
  articleText,
  topicText,
  answerText,
  question,
  locale,
}: {
  /** Backward-compatible alias for a self-contained answer passage. */
  articleText?: string;
  topicText?: string;
  answerText?: string;
  question: KnowledgeCoverageQuestion;
  locale: AiEvaluationLocale;
}): boolean => {
  const rawAnswer = answerText ?? articleText ?? "";
  if (!isAnswerBearingCoverageText(rawAnswer, locale)) return false;
  const normalizedAnswer = normalizeCoverageText(rawAnswer);
  const normalizedTopic = normalizeCoverageText(
    [topicText, rawAnswer].filter(Boolean).join(" "),
  );
  const matchedTopicGroups = question.signals[locale].filter((alternatives) =>
    alternatives.some((signal) => matchesSignal(normalizedTopic, signal)),
  ).length;
  if (matchedTopicGroups < question.minimumSignalGroups) return false;
  const matchedAnswerGroups = question.answerSignals[locale].filter(
    (alternatives) =>
      alternatives.some((signal) => matchesSignal(normalizedAnswer, signal)),
  ).length;
  return matchedAnswerGroups >= question.minimumAnswerSignalGroups;
};

/** Pure deterministic evaluator. It imports no database or AI provider code. */
export const evaluateKnowledgeCoverageDocuments = ({
  documents,
  locale,
  requestedLocale = locale,
  generatedAt = new Date().toISOString(),
  truncated = false,
}: {
  documents: KnowledgeCoverageDocument[];
  locale: AiEvaluationLocale;
  requestedLocale?: AiLocale;
  generatedAt?: string;
  truncated?: boolean;
}): KnowledgeCoverageHealth => {
  const normalizedDocuments = documents
    .map((document) =>
      typeof document === "string"
        ? { answerText: document }
        : {
            topicText: String(document?.topicText ?? ""),
            answerText: String(document?.answerText ?? ""),
          },
    )
    .filter((document) => normalizeCoverageText(document.answerText));
  const answered = new Set(
    CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.filter((question) =>
      normalizedDocuments.some((document) =>
        articleCoversQuestion({ ...document, question, locale }),
      ),
    ).map((question) => question.id),
  );
  const totalCount = CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.length;
  const warnings = CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.filter(
    (question) => !answered.has(question.id),
  ).map((question) => ({
    id: question.id,
    code: "knowledge_gap" as const,
    question: question.question[locale],
    category: question.category,
    severity: question.severity,
  }));
  return {
    requestedLocale,
    evaluationLocale: locale,
    localeFallback: requestedLocale !== locale,
    generatedAt,
    score: totalCount ? Math.round((answered.size / totalCount) * 100) : 100,
    answeredCount: answered.size,
    totalCount,
    warnings,
    complete: !truncated,
    truncated,
  };
};
