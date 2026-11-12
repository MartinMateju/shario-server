import { createHash } from "node:crypto";

export const AI_FEEDBACK_REDACTION_VERSION = "feedback-redaction-v1";
export const AI_FEEDBACK_PATTERN_VERSION = "feedback-pattern-v1";

export type FeedbackRegressionObservation = {
  tenantId: string;
  locale: string;
  prompt: string;
  answer: string;
  createdAt: Date | string;
  promptVersion?: string;
  model?: string;
  provider?: string;
  groundingStatus?: string;
};

export type FeedbackRegressionSample = {
  prompt: string;
  answer: string;
};

export type FeedbackRegressionCandidate = {
  fingerprint: string;
  locale: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  promptVersions: string[];
  models: string[];
  providers: string[];
  groundingStatuses: string[];
  samples?: FeedbackRegressionSample[];
};

export type FeedbackRegressionReport = {
  schemaVersion: "ai-feedback-regression-report-v1";
  redactionVersion: typeof AI_FEEDBACK_REDACTION_VERSION;
  patternVersion: typeof AI_FEEDBACK_PATTERN_VERSION;
  generatedAt: string;
  tenantFingerprint: string;
  minimumOccurrences: number;
  includesRedactedText: boolean;
  summary: {
    suppliedObservations: number;
    tenantMatchedObservations: number;
    eligibleObservations: number;
    discardedObservations: number;
    repeatedCandidateCount: number;
    singletonPatternCount: number;
  };
  candidates: FeedbackRegressionCandidate[];
  privacyNotice: string;
};

const MAX_REDACTED_TEXT_LENGTH = 2_000;
const MAX_PATTERN_TOKENS = 80;

const PATTERN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "do",
  "does",
  "i",
  "is",
  "me",
  "my",
  "our",
  "please",
  "tell",
  "the",
  "there",
  "we",
  "what",
  "would",
  "you",
  "ať",
  "bych",
  "bychom",
  "co",
  "do",
  "je",
  "jsou",
  "mam",
  "mame",
  "mám",
  "máme",
  "mi",
  "moje",
  "muj",
  "můj",
  "nas",
  "náš",
  "prosim",
  "prosím",
  "se",
  "ve",
  "v",
  "vy",
]);

const fingerprint = (value: string, length = 24) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

const nonEmptySorted = (values: Array<string | undefined>): string[] =>
  [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .sort()
    .slice(0, 20);

const normalizedLocale = (value: string): string => {
  const locale = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  if (locale === "cz") return "cs";
  return locale || "unknown";
};

/**
 * Removes common direct identifiers before an operator may opt into seeing a
 * sample. The default report never contains prompts or answers at all.
 */
export const redactFeedbackText = (value: unknown): string => {
  let text = String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");

  text = text
    .replace(/\[[^\]]{0,200}\]\(https?:\/\/[^\s)]+\)/giu, "[link]")
    .replace(/\bhttps?:\/\/[^\s<>()]+/giu, "[url]")
    .replace(/\bwww\.[^\s<>()]+/giu, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[id]")
    .replace(/\b[0-9a-f]{24}\b/giu, "[id]")
    .replace(/“[^”\n]{1,240}”/gu, "[quoted-text]")
    .replace(/„[^“\n]{1,240}“/gu, "[quoted-text]")
    .replace(/"[^"\n]{1,240}"/gu, "[quoted-text]")
    .replace(/'[^'\n]{1,240}'/gu, "[quoted-text]")
    .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/gu, "[phone]")
    .replace(/\b\d{1,2}[.:]\d{2}(?:\s?(?:am|pm))?\b/giu, "[time]")
    .replace(/\b\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\b/gu, "[date]")
    .replace(/\b\d+(?:[.,]\d+)?\b/gu, "[number]")
    .replace(/\b(?=[A-Za-z0-9_-]{20,}\b)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+\b/gu, "[token]")
    .replace(
      /\b\p{Lu}[\p{Ll}\p{M}]{1,}(?:\s+\p{Lu}[\p{Ll}\p{M}]{1,})*\b/gu,
      "[name-or-entity]",
    )
    .replace(/\b\p{Lu}{2,}\b/gu, "[name-or-entity]")
    .replace(/\s+/gu, " ")
    .trim();

  return text.slice(0, MAX_REDACTED_TEXT_LENGTH);
};

/**
 * Creates a deliberately coarse lexical pattern. This is used only to find
 * repeated candidates for human review; it is never treated as a product
 * intent classifier and never changes assistant behavior.
 */
export const createFeedbackPattern = ({
  locale,
  prompt,
}: {
  locale: string;
  prompt: string;
}): { canonical: string; fingerprint: string; locale: string } => {
  const language = normalizedLocale(locale);
  // Lowercase first so capitalization-based entity redaction cannot make the
  // same lexical prompt produce a different grouping fingerprint.
  const normalized = redactFeedbackText(String(prompt || "").toLowerCase())
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\[([^\]]+)\]/gu, " $1 ")
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .trim();
  const allTokens = normalized.split(/\s+/u).filter(Boolean);
  const meaningfulTokens = allTokens.filter(
    (token) => !PATTERN_STOP_WORDS.has(token),
  );
  const tokens = (meaningfulTokens.length >= 2 ? meaningfulTokens : allTokens)
    .slice(0, MAX_PATTERN_TOKENS)
    .sort();
  const canonical = tokens.join(" ") || "empty";
  return {
    canonical,
    fingerprint: fingerprint(`${AI_FEEDBACK_PATTERN_VERSION}:${language}:${canonical}`),
    locale: language,
  };
};

export const buildFeedbackRegressionReport = ({
  tenantId,
  observations,
  minimumOccurrences = 2,
  includeRedactedText = false,
  generatedAt = new Date(),
}: {
  tenantId: string;
  observations: FeedbackRegressionObservation[];
  minimumOccurrences?: number;
  includeRedactedText?: boolean;
  generatedAt?: Date;
}): FeedbackRegressionReport => {
  const tenant = String(tenantId || "").trim();
  if (!tenant) throw new Error("tenantId is required.");
  if (!Number.isInteger(minimumOccurrences) || minimumOccurrences < 2) {
    throw new Error("minimumOccurrences must be an integer of at least 2.");
  }

  type Group = {
    pattern: ReturnType<typeof createFeedbackPattern>;
    observations: Array<FeedbackRegressionObservation & { createdDate: Date }>;
  };
  const groups = new Map<string, Group>();
  let tenantMatchedObservations = 0;
  let eligibleObservations = 0;

  for (const observation of observations) {
    if (String(observation.tenantId || "") !== tenant) continue;
    tenantMatchedObservations += 1;
    const createdDate = new Date(observation.createdAt);
    const prompt = String(observation.prompt || "").trim();
    if (!prompt || Number.isNaN(createdDate.getTime())) continue;
    eligibleObservations += 1;
    const pattern = createFeedbackPattern({
      locale: observation.locale,
      prompt,
    });
    const key = `${pattern.locale}:${pattern.fingerprint}`;
    const group = groups.get(key) || { pattern, observations: [] };
    group.observations.push({ ...observation, createdDate });
    groups.set(key, group);
  }

  const candidates = [...groups.values()]
    .filter((group) => group.observations.length >= minimumOccurrences)
    .map((group): FeedbackRegressionCandidate => {
      const ordered = [...group.observations].sort(
        (left, right) => left.createdDate.getTime() - right.createdDate.getTime(),
      );
      const candidate: FeedbackRegressionCandidate = {
        fingerprint: group.pattern.fingerprint,
        locale: group.pattern.locale,
        occurrences: ordered.length,
        firstSeenAt: ordered[0]!.createdDate.toISOString(),
        lastSeenAt: ordered.at(-1)!.createdDate.toISOString(),
        promptVersions: nonEmptySorted(ordered.map((item) => item.promptVersion)),
        models: nonEmptySorted(ordered.map((item) => item.model)),
        providers: nonEmptySorted(ordered.map((item) => item.provider)),
        groundingStatuses: nonEmptySorted(
          ordered.map((item) => item.groundingStatus),
        ),
      };
      if (includeRedactedText) {
        candidate.samples = ordered.slice(-3).map((item) => ({
          prompt: redactFeedbackText(item.prompt),
          answer: redactFeedbackText(item.answer),
        }));
      }
      return candidate;
    })
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        right.lastSeenAt.localeCompare(left.lastSeenAt) ||
        left.fingerprint.localeCompare(right.fingerprint),
    );

  const singletonPatternCount = [...groups.values()].filter(
    (group) => group.observations.length < minimumOccurrences,
  ).length;

  return {
    schemaVersion: "ai-feedback-regression-report-v1",
    redactionVersion: AI_FEEDBACK_REDACTION_VERSION,
    patternVersion: AI_FEEDBACK_PATTERN_VERSION,
    generatedAt: generatedAt.toISOString(),
    tenantFingerprint: fingerprint(`tenant:${tenant}`, 16),
    minimumOccurrences,
    includesRedactedText: includeRedactedText,
    summary: {
      suppliedObservations: observations.length,
      tenantMatchedObservations,
      eligibleObservations,
      discardedObservations: observations.length - eligibleObservations,
      repeatedCandidateCount: candidates.length,
      singletonPatternCount,
    },
    candidates,
    privacyNotice: includeRedactedText
      ? "Samples are mechanically redacted but may still require privacy review. Keep this local report out of version control and replace production wording with synthetic fixtures before promotion."
      : "Prompt and answer text are omitted. Review fingerprints and counts first; opt into mechanically redacted local samples only when necessary.",
  };
};
