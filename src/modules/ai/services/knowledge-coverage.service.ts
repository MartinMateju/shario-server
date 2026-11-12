import LocationModel from "@/modules/location/location.model.js";
import { CommunicationKnowledgeArticleModel } from "@/modules/communications/communications.models.js";
import {
  canAccessWorkspaceLocation,
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/index.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";

import { AI_KNOWLEDGE_AUDIENCE } from "../ai.constants.js";
import {
  resolveAiEvaluationLocale,
  type AiEvaluationLocale,
} from "../ai-evaluation.catalog.js";
import { resolveAiLocale, type AiLocale } from "../ai-locale.js";
import type { AiRequestContext } from "../ai.types.js";
import { requireAiEntitlement } from "./ai-access.service.js";
import {
  containsPromptInjection,
  containsSensitiveAccessSecret,
} from "./ai-policy.service.js";
import { buildKnowledgeRetrievalQuery } from "./knowledge-retrieval.service.js";
import {
  evaluateKnowledgeCoverageDocuments,
  type KnowledgeCoverageDocument,
  type KnowledgeCoverageHealth,
} from "./knowledge-coverage-evaluator.js";

export const KNOWLEDGE_COVERAGE_ARTICLE_LIMIT = 500;

type KnowledgeCoverageArticle = {
  /** Accepted for compatibility but deliberately excluded from scoring. */
  title?: unknown;
  summary?: unknown;
  content?: unknown;
  transcript?: unknown;
  customQuestions?: unknown;
  translations?: unknown;
  category?: unknown;
  tags?: unknown;
};

const customQuestionDocuments = (
  value: unknown,
): KnowledgeCoverageDocument[] =>
  Array.isArray(value)
    ? value.flatMap((entry: any) => {
        const answerText = String(entry?.answer ?? "").trim();
        if (!answerText) return [];
        const topicText = String(entry?.question ?? "").trim();
        return [{ ...(topicText ? { topicText } : {}), answerText }];
      })
    : [];

const answerBodyDocuments = (
  fields: Record<string, unknown>,
): KnowledgeCoverageDocument[] => [
  ...[fields.summary, fields.content, fields.transcript]
    .map((answerText) => String(answerText ?? "").trim())
    .filter(Boolean),
  ...customQuestionDocuments(fields.customQuestions),
];

const translationDocumentsForCoverage = (
  translations: unknown,
  locale: AiEvaluationLocale,
): KnowledgeCoverageDocument[] => {
  if (!translations || typeof translations !== "object") return [];
  const candidate = translations as Record<string, unknown> & {
    get?: (key: string) => unknown;
  };
  const localized = candidate[locale] ?? candidate.get?.(locale);
  if (typeof localized === "string") return [localized];
  if (!localized || typeof localized !== "object") return [];
  return answerBodyDocuments(localized as Record<string, unknown>);
};

const coverageArticleDocuments = (
  article: KnowledgeCoverageArticle,
  locale: AiEvaluationLocale,
): KnowledgeCoverageDocument[] =>
  [
    ...answerBodyDocuments(article as Record<string, unknown>),
    ...translationDocumentsForCoverage(article.translations, locale),
  ].filter((document) => {
    const raw =
      typeof document === "string"
        ? document
        : [document.topicText, document.answerText].filter(Boolean).join("\n");
    return !containsPromptInjection(raw) && !containsSensitiveAccessSecret(raw);
  });

/**
 * Offline, deterministic coverage scoring. This intentionally performs no
 * embedding or model call, so the same catalog powers product diagnostics and
 * CI without consuming tenant credits or introducing provider flakiness.
 */
export const evaluateKnowledgeCoverage = ({
  articles,
  locale,
  generatedAt = new Date().toISOString(),
  truncated = false,
}: {
  articles: KnowledgeCoverageArticle[];
  locale: AiLocale;
  generatedAt?: string;
  truncated?: boolean;
}): KnowledgeCoverageHealth => {
  const requestedLocale = resolveAiLocale(locale);
  const evaluationLocale = resolveAiEvaluationLocale(requestedLocale);
  const searchableDocuments = articles.flatMap((article) =>
    coverageArticleDocuments(article, evaluationLocale),
  );
  return evaluateKnowledgeCoverageDocuments({
    documents: searchableDocuments,
    locale: evaluationLocale,
    requestedLocale,
    generatedAt,
    truncated,
  });
};

const generalCustomerAudiences = [
  AI_KNOWLEDGE_AUDIENCE.PUBLIC,
  AI_KNOWLEDGE_AUDIENCE.CUSTOMER,
] as const;

export const getKnowledgeCoverageHealth = async ({
  context,
  locale,
  locationId = null,
}: {
  context: AiRequestContext;
  locale: AiLocale;
  locationId?: string | null;
}): Promise<KnowledgeCoverageHealth> => {
  const requestedLocale = resolveAiLocale(locale);
  const evaluationLocale = resolveAiEvaluationLocale(requestedLocale);
  const access = context.access;
  if (
    !access ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.KNOWLEDGE_VIEW)
  ) {
    forbidden({
      message: "Knowledge Hub access is required.",
      code: "KNOWLEDGE_ACCESS_REQUIRED",
    });
  }
  await requireAiEntitlement(context.tenantId, "knowledgeBaseEnabled");
  if (locationId) {
    if (!canAccessWorkspaceLocation(access, locationId)) {
      notFound("Location not found.");
    }
    const locationExists = await LocationModel.exists({
      _id: locationId,
      tenant: context.tenantId,
    });
    if (!locationExists) notFound("Location not found.");
  }

  const visibilityFilter = buildKnowledgeRetrievalQuery({
    tenantId: context.tenantId,
    audiences: generalCustomerAudiences,
    // A tenant-wide diagnostic evaluates global articles only. A location
    // diagnostic evaluates global plus that one authorized location; it must
    // never merge unrelated locations into a deceptively complete score.
    allowedLocationIds: [],
    locationId,
    locale: evaluationLocale,
    includeAllTargets: false,
  });
  // Audience is the primary boundary. Empty target arrays additionally fail
  // closed for malformed/legacy public records that still carry a member or
  // course target and therefore are not truly general customer guidance.
  const filter = {
    $and: [
      visibilityFilter,
      {
        $or: [
          { targetMembershipIds: { $exists: false } },
          { targetMembershipIds: { $size: 0 } },
        ],
      },
      {
        $or: [
          { targetCourseIds: { $exists: false } },
          { targetCourseIds: { $size: 0 } },
        ],
      },
    ],
  };
  const candidates = await CommunicationKnowledgeArticleModel.find(filter)
    .select("summary content transcript customQuestions translations")
    .sort({ updatedAt: -1, _id: 1 })
    // Fetch one sentinel row so a capped scan is observable to callers.
    .limit(KNOWLEDGE_COVERAGE_ARTICLE_LIMIT + 1)
    .lean();
  const truncated = candidates.length > KNOWLEDGE_COVERAGE_ARTICLE_LIMIT;
  const articles = truncated
    ? candidates.slice(0, KNOWLEDGE_COVERAGE_ARTICLE_LIMIT)
    : candidates;

  return evaluateKnowledgeCoverage({
    articles,
    locale: requestedLocale,
    generatedAt: new Date().toISOString(),
    truncated,
  });
};

export const knowledgeCoverageService = {
  evaluate: evaluateKnowledgeCoverage,
  get: getKnowledgeCoverageHealth,
};
