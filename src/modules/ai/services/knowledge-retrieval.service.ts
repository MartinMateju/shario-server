import { createHash, randomUUID } from "node:crypto";
import { isValidObjectId } from "mongoose";

import { logger } from "@/config/logger.js";
import { CommunicationKnowledgeArticleModel } from "@/modules/communications/communications.models.js";
import { normalizeYouTubeUrl } from "@/modules/communications/knowledge-youtube.js";
import {
  buildPublishedKnowledgeVisibilityFilter,
  resolveCustomerKnowledgeEntitlements,
} from "@/modules/communications/services/knowledge-access.service.js";
import {
  canAccessWorkspaceLocation,
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/index.js";
import { notFound } from "@/shared/http/httpErrors.js";

import {
  AI_AUDIENCE,
  AI_FEATURE,
  AI_KNOWLEDGE_AUDIENCE,
  type AiKnowledgeAudience,
} from "../ai.constants.js";
import { normalizeAiLocale, type AiLocale } from "../ai-locale.js";
import type { AiRequestContext } from "../ai.types.js";
import {
  KNOWLEDGE_RETRIEVAL_CONFIDENCE,
  KNOWLEDGE_RETRIEVAL_MODE,
  KNOWLEDGE_RETRIEVAL_STATUS,
  type KnowledgeRetrievalCoverage,
  type KnowledgeRetrievalResult,
  type RetrievedKnowledgeSource,
} from "../knowledge-retrieval.types.js";
import { requireAiEntitlement } from "./ai-access.service.js";
import { containsPromptInjection } from "./ai-policy.service.js";
import { createEmbedding, isOpenAiConfigured } from "./openai.provider.js";
import {
  releaseAiCredits,
  reserveAiCredits,
  settleAiCredits,
} from "./ai-usage.service.js";

export const KNOWLEDGE_RETRIEVAL_CANDIDATE_LIMIT = 500;
export const KNOWLEDGE_RETRIEVAL_CHUNK_LIMIT = 24;
export const KNOWLEDGE_RETRIEVAL_CHUNK_CHARS = 1_800;
export const KNOWLEDGE_RETRIEVAL_CHUNK_OVERLAP = 180;
export const KNOWLEDGE_INDEX_VERSION = "knowledge-article-v2";
export const KNOWLEDGE_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
export const KNOWLEDGE_EMBEDDING_CONFIGURATION_RETRY_MS = 30 * 60_000;
export const KNOWLEDGE_EMBEDDING_MAX_RETRY_MS = 12 * 60 * 60_000;

const nextEmbeddingRetryAt = (attempts: number): Date =>
  new Date(
    Date.now() +
      Math.min(
        15 * 60_000 * 2 ** Math.max(Math.min(attempts - 1, 6), 0),
        KNOWLEDGE_EMBEDDING_MAX_RETRY_MS,
      ),
  );

const nextConfigurationRetryAt = (): Date =>
  new Date(Date.now() + KNOWLEDGE_EMBEDDING_CONFIGURATION_RETRY_MS);

const KNOWLEDGE_STOP_WORDS = new Set([
  "about",
  "also",
  "and",
  "are",
  "can",
  "could",
  "does",
  "from",
  "have",
  "how",
  "into",
  "our",
  "please",
  "that",
  "the",
  "their",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "your",
  "aby",
  "ale",
  "co",
  "jak",
  "jaka",
  "jake",
  "jaky",
  "jsem",
  "jsme",
  "jsou",
  "kde",
  "kdy",
  "ktere",
  "ktery",
  "ma",
  "mam",
  "mame",
  "mate",
  "moje",
  "nase",
  "nebo",
  "pro",
  "prosim",
  "se",
  "si",
  "to",
  "ve",
  "zda",
  "ze",
]);

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeSearchText = (value: unknown): string =>
  String(value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const normalizeKnowledgeText = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();

export const normalizeKnowledgeLocale = (
  value: unknown,
): AiLocale | null => normalizeAiLocale(value);

export const normalizedKnowledgeTerms = (query: string): string[] => [
  ...new Set(
    normalizeSearchText(query)
      .split(" ")
      .filter((term) => term.length >= 3 && !KNOWLEDGE_STOP_WORDS.has(term))
      .slice(0, 20),
  ),
];

const safeKnowledgeSourceUrl = (article: any): string => {
  const canonicalVideo = normalizeYouTubeUrl(article.videoUrl);
  if (canonicalVideo) return canonicalVideo;
  try {
    const url = new URL(String(article.sourceUrl || ""));
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      return url.toString();
    }
  } catch {
    // Internal files are linked through the authorized Knowledge Hub surface.
  }
  return "";
};

const knowledgeSourceHref = (
  context: AiRequestContext,
  article: any,
): string => {
  const resourceId = encodeURIComponent(String(article._id));
  if (
    context.audience === AI_AUDIENCE.WORKSPACE &&
    hasWorkspacePermission(context.access, WORKSPACE_PERMISSION.KNOWLEDGE_VIEW)
  ) {
    return `/app/knowledge?resource=${resourceId}`;
  }
  if (context.audience === AI_AUDIENCE.CUSTOMER) {
    return `/portal/knowledge?resource=${resourceId}`;
  }
  if (
    context.audience === AI_AUDIENCE.PUBLIC ||
    String(article.audience || "") === AI_KNOWLEDGE_AUDIENCE.PUBLIC
  ) {
    return `/help/${resourceId}`;
  }
  return "";
};

const translationFor = (article: any, locale: AiLocale): string =>
  normalizeKnowledgeText(
    article.translations?.[locale] || article.translations?.get?.(locale) || "",
  );

type KnowledgeChunk = {
  ordinal: number;
  kind: RetrievedKnowledgeSource["kind"];
  content: string;
};

const splitKnowledgeSection = (
  value: string,
  kind: KnowledgeChunk["kind"],
  startOrdinal: number,
): KnowledgeChunk[] => {
  const text = normalizeKnowledgeText(value);
  if (!text) return [];
  const chunks: KnowledgeChunk[] = [];
  let offset = 0;
  while (
    offset < text.length &&
    chunks.length < KNOWLEDGE_RETRIEVAL_CHUNK_LIMIT
  ) {
    const tentativeEnd = Math.min(
      offset + KNOWLEDGE_RETRIEVAL_CHUNK_CHARS,
      text.length,
    );
    let end = tentativeEnd;
    if (tentativeEnd < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", tentativeEnd),
        text.lastIndexOf(". ", tentativeEnd),
        text.lastIndexOf(" ", tentativeEnd),
      );
      if (boundary > offset + KNOWLEDGE_RETRIEVAL_CHUNK_CHARS / 2) {
        end = boundary + (text[boundary] === "." ? 1 : 0);
      }
    }
    const content = text.slice(offset, end).trim();
    if (content) {
      chunks.push({
        ordinal: startOrdinal + chunks.length,
        kind,
        content,
      });
    }
    if (end >= text.length) break;
    offset = Math.max(end - KNOWLEDGE_RETRIEVAL_CHUNK_OVERLAP, offset + 1);
  }
  return chunks;
};

export const buildKnowledgeChunks = (
  article: any,
  locale: AiLocale,
): KnowledgeChunk[] => {
  const sections: Array<{
    kind: KnowledgeChunk["kind"];
    content: string;
  }> = [];
  const translated = translationFor(article, locale);
  const articleLocale = normalizeKnowledgeLocale(article.language);
  const usingTranslation = Boolean(
    translated && articleLocale && articleLocale !== locale,
  );
  const summary = usingTranslation
    ? ""
    : normalizeKnowledgeText(article.summary);
  const content = translated || normalizeKnowledgeText(article.content);
  const transcript = usingTranslation
    ? ""
    : normalizeKnowledgeText(article.transcript);
  // Summaries and curated Q&A are the strongest citation targets. Reserve
  // space for them before long body/transcript sections consume the cap.
  if (summary) sections.push({ kind: "summary", content: summary });
  for (const entry of usingTranslation ? [] : article.customQuestions || []) {
    const question = normalizeKnowledgeText(entry?.question);
    const answer = normalizeKnowledgeText(entry?.answer);
    if (question && answer) {
      sections.push({
        kind: "faq",
        content: `Question: ${question}\nAnswer: ${answer}`,
      });
    }
  }
  if (content) sections.push({ kind: "content", content });
  if (transcript) sections.push({ kind: "transcript", content: transcript });
  if (sections.length === 0) {
    sections.push({
      kind: "metadata",
      content: [
        `Title: ${normalizeKnowledgeText(article.title)}`,
        `Type: ${normalizeKnowledgeText(article.type || "resource")}`,
        `Category: ${normalizeKnowledgeText(article.category || "general")}`,
        (article.tags || []).length
          ? `Tags: ${(article.tags || []).map(normalizeKnowledgeText).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    const remaining = KNOWLEDGE_RETRIEVAL_CHUNK_LIMIT - chunks.length;
    if (remaining <= 0) break;
    chunks.push(
      ...splitKnowledgeSection(
        section.content,
        section.kind,
        chunks.length,
      ).slice(0, remaining),
    );
  }
  return chunks;
};

const countTerm = (text: string, term: string): number =>
  Math.min(
    text.match(new RegExp(`\\b${escapeRegex(term)}`, "g"))?.length || 0,
    6,
  );

const lexicalScoreForChunk = ({
  article,
  chunk,
  terms,
  normalizedQuery,
}: {
  article: any;
  chunk: KnowledgeChunk;
  terms: string[];
  normalizedQuery: string;
}): { score: number; coverage: number } => {
  if (!terms.length) return { score: 0, coverage: 0 };
  const title = normalizeSearchText(article.title);
  const tags = normalizeSearchText((article.tags || []).join(" "));
  const category = normalizeSearchText(article.category);
  const content = normalizeSearchText(chunk.content);
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const titleHits = countTerm(title, term);
    const tagHits = countTerm(tags, term);
    const categoryHits = countTerm(category, term);
    const contentHits = countTerm(content, term);
    if (titleHits || tagHits || categoryHits || contentHits) matched += 1;
    score +=
      titleHits * 7 + tagHits * 4 + categoryHits * 2.5 + contentHits * 1.5;
  }
  const coverage = matched / terms.length;
  if (normalizedQuery.length >= 5 && content.includes(normalizedQuery)) {
    score += 10;
  }
  if (chunk.kind === "faq" && coverage >= 0.6) score += 5;
  if (terms.length >= 3 && coverage < 0.34) score *= 0.25;
  return { score, coverage };
};

const cosineSimilarity = (left: unknown, right: unknown): number | null => {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length)
    return null;
  if (left.length !== right.length) return null;
  const length = left.length;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue))
      return null;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (!leftNorm || !rightNorm) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const queryEmbedding = async ({
  context,
  query,
  retrievalId,
}: {
  context: AiRequestContext;
  query: string;
  retrievalId: string;
}): Promise<{ vector: number[]; model: string } | null> => {
  if (!isOpenAiConfigured()) return null;
  let reservation: any = null;
  try {
    reservation = await reserveAiCredits({
      tenantId: context.tenantId,
      actorId: context.userId,
      feature: AI_FEATURE.KNOWLEDGE_RETRIEVAL,
      idempotencyKey: `knowledge-retrieval:${retrievalId}`,
      credits: 1,
    });
    const result = await createEmbedding(
      normalizeKnowledgeText(query).slice(0, 4_000),
    );
    await settleAiCredits({
      reservationId: String(reservation._id),
      usage: result.usage,
      model: result.model,
    });
    return { vector: result.vector, model: result.model };
  } catch (error) {
    if (reservation?._id) {
      await releaseAiCredits(String(reservation._id)).catch(() => undefined);
    }
    logger.warn(
      {
        errorType: error instanceof Error ? error.name : "UnknownError",
        tenantId: context.tenantId,
      },
      "Semantic knowledge retrieval unavailable; using lexical fallback.",
    );
    return null;
  }
};

const emptyKnowledgeResult = ({
  status,
  locale,
  retrievedAt,
}: {
  status: KnowledgeRetrievalCoverage["status"];
  locale: AiLocale;
  retrievedAt: string;
}): KnowledgeRetrievalResult => ({
  sources: [],
  coverage: {
    status,
    mode: KNOWLEDGE_RETRIEVAL_MODE.LEXICAL,
    confidence: KNOWLEDGE_RETRIEVAL_CONFIDENCE.INSUFFICIENT,
    indexStatus: "unavailable",
    candidateCount: 0,
    semanticCandidateCount: 0,
    returnedCount: 0,
    truncated: false,
    locale,
    retrievedAt,
  },
});

export const buildKnowledgeRetrievalQuery = ({
  tenantId,
  audiences,
  allowedLocationIds = null,
  locationId = null,
  locale,
  now = new Date(),
  membershipPlanIds = [],
  courseProductIds = [],
  includeAllTargets = false,
}: {
  tenantId: string;
  audiences: readonly AiKnowledgeAudience[];
  allowedLocationIds?: readonly string[] | null;
  locationId?: string | null;
  locale?: string;
  now?: Date;
  membershipPlanIds?: readonly string[];
  courseProductIds?: readonly string[];
  includeAllTargets?: boolean;
}): Record<string, unknown> => {
  const safeLocale = normalizeKnowledgeLocale(locale);
  return buildPublishedKnowledgeVisibilityFilter({
    tenantId,
    audiences,
    membershipPlanIds,
    courseProductIds,
    includeAllTargets,
    includeLegacyStaff: audiences.includes(AI_KNOWLEDGE_AUDIENCE.STAFF),
    allowedLocationIds,
    locationId,
    ...(safeLocale ? { locale: safeLocale } : {}),
    now,
    aiOnly: true,
  });
};

export const audiencesForContext = (
  context: AiRequestContext,
): AiKnowledgeAudience[] => {
  if (context.audience === AI_AUDIENCE.PUBLIC) {
    return [AI_KNOWLEDGE_AUDIENCE.PUBLIC];
  }
  if (context.audience === AI_AUDIENCE.CUSTOMER) {
    return [
      AI_KNOWLEDGE_AUDIENCE.PUBLIC,
      AI_KNOWLEDGE_AUDIENCE.CUSTOMER,
      AI_KNOWLEDGE_AUDIENCE.MEMBER,
      AI_KNOWLEDGE_AUDIENCE.COURSE,
    ];
  }
  if (context.audience === AI_AUDIENCE.WORKSPACE) {
    const sharedAudiences = [
      AI_KNOWLEDGE_AUDIENCE.CUSTOMER,
      AI_KNOWLEDGE_AUDIENCE.PUBLIC,
    ];

    // AI access is intentionally independent from Knowledge Hub access.
    // A custom role with only `ai.use` may use customer/public material, but
    // staff-only and legacy no-audience articles require `knowledge.view`.
    if (
      !hasWorkspacePermission(
        context.access,
        WORKSPACE_PERMISSION.KNOWLEDGE_VIEW,
      )
    ) {
      // `ai.use` alone must not become an alternate path to authenticated
      // customer or internal Knowledge Hub material.
      return [AI_KNOWLEDGE_AUDIENCE.PUBLIC];
    }
    return [
      AI_KNOWLEDGE_AUDIENCE.STAFF,
      AI_KNOWLEDGE_AUDIENCE.MEMBER,
      AI_KNOWLEDGE_AUDIENCE.COURSE,
      ...(context.access?.role === WORKSPACE_ROLE.OWNER
        ? [AI_KNOWLEDGE_AUDIENCE.OWNER]
        : []),
      ...sharedAudiences,
    ];
  }

  // System jobs operate with their own trusted tenant-scoped context.
  return [
    AI_KNOWLEDGE_AUDIENCE.STAFF,
    AI_KNOWLEDGE_AUDIENCE.MEMBER,
    AI_KNOWLEDGE_AUDIENCE.COURSE,
    AI_KNOWLEDGE_AUDIENCE.CUSTOMER,
    AI_KNOWLEDGE_AUDIENCE.PUBLIC,
  ];
};

export const retrieveKnowledge = async ({
  context,
  query,
  limit = 8,
  pinnedSourceId = null,
  retrievalId = randomUUID(),
}: {
  context: AiRequestContext;
  query: string;
  limit?: number;
  pinnedSourceId?: string | null;
  retrievalId?: string;
}): Promise<KnowledgeRetrievalResult> => {
  const locale = normalizeKnowledgeLocale(context.locale) || "en";
  const retrievedAt = new Date().toISOString();
  try {
    await requireAiEntitlement(context.tenantId, "knowledgeBaseEnabled");
  } catch (error: any) {
    if (error?.code === "AI_FEATURE_DISABLED") {
      return emptyKnowledgeResult({
        status: KNOWLEDGE_RETRIEVAL_STATUS.DISABLED,
        locale,
        retrievedAt,
      });
    }
    throw error;
  }
  if (
    context.audience === AI_AUDIENCE.WORKSPACE &&
    context.locationId &&
    (!context.access ||
      !canAccessWorkspaceLocation(context.access, context.locationId))
  ) {
    notFound({
      message: "Knowledge source not found.",
      code: "KNOWLEDGE_SOURCE_NOT_FOUND",
    });
  }
  const customerEntitlements =
    context.audience === AI_AUDIENCE.CUSTOMER && context.userId
      ? await resolveCustomerKnowledgeEntitlements({
          tenantId: context.tenantId,
          userId: context.userId,
        })
      : { membershipPlanIds: [], courseProductIds: [] };
  const includeAllTargets =
    context.audience === AI_AUDIENCE.SYSTEM ||
    (context.audience === AI_AUDIENCE.WORKSPACE &&
      hasWorkspacePermission(
        context.access,
        WORKSPACE_PERMISSION.KNOWLEDGE_VIEW,
      ));
  const allowedLocationIds =
    context.audience === AI_AUDIENCE.WORKSPACE
      ? context.access
        ? getAllowedWorkspaceLocationIds(context.access)
        : []
      : context.audience === AI_AUDIENCE.PUBLIC ||
          context.audience === AI_AUDIENCE.CUSTOMER
        ? context.locationId
          ? null
          : []
        : (context.allowedLocationIds ?? null);
  const filter = buildKnowledgeRetrievalQuery({
    tenantId: context.tenantId,
    audiences: audiencesForContext(context),
    allowedLocationIds,
    locationId: context.locationId ?? null,
    locale,
    membershipPlanIds: customerEntitlements.membershipPlanIds,
    courseProductIds: customerEntitlements.courseProductIds,
    includeAllTargets,
  });
  if (pinnedSourceId && !isValidObjectId(pinnedSourceId)) {
    return emptyKnowledgeResult({
      status: KNOWLEDGE_RETRIEVAL_STATUS.NO_MATCH,
      locale,
      retrievedAt,
    });
  }
  const authorizedFilter = pinnedSourceId
    ? { $and: [filter, { _id: pinnedSourceId }] }
    : filter;
  let articles: any[];
  try {
    articles = await CommunicationKnowledgeArticleModel.find(authorizedFilter)
      .select(
        "+embeddingVector type title summary content transcript customQuestions translations language audience category tags locationIds sourceUrl videoUrl version contentHash embeddingStatus embeddingModel embeddingIndexVersion embeddedAt updatedAt",
      )
      .sort({ updatedAt: -1, _id: 1 })
      .limit(KNOWLEDGE_RETRIEVAL_CANDIDATE_LIMIT)
      .lean();
  } catch (error) {
    logger.warn(
      {
        errorType: error instanceof Error ? error.name : "UnknownError",
        tenantId: context.tenantId,
      },
      "Knowledge retrieval failed.",
    );
    return emptyKnowledgeResult({
      status: KNOWLEDGE_RETRIEVAL_STATUS.UNAVAILABLE,
      locale,
      retrievedAt,
    });
  }

  const terms = normalizedKnowledgeTerms(query);
  const normalizedQuery = terms.join(" ");
  const semanticArticles = articles.filter(
    (article) =>
      article.embeddingStatus === "ready" &&
      article.embeddingIndexVersion === KNOWLEDGE_INDEX_VERSION &&
      article.embeddingModel === KNOWLEDGE_EMBEDDING_MODEL &&
      Array.isArray(article.embeddingVector) &&
      article.embeddingVector.length > 0,
  );
  const embeddedQuery = semanticArticles.length
    ? await queryEmbedding({ context, query, retrievalId })
    : null;
  const semanticScores = new Map<string, number>();
  if (embeddedQuery) {
    for (const article of semanticArticles) {
      if (String(article.embeddingModel || "") !== embeddedQuery.model)
        continue;
      const similarity = cosineSimilarity(
        article.embeddingVector,
        embeddedQuery.vector,
      );
      if (similarity !== null) {
        semanticScores.set(String(article._id), similarity);
      }
    }
  }

  const scored: Array<RetrievedKnowledgeSource & { termCoverage: number }> = [];
  for (const article of articles) {
    const articleId = String(article._id);
    const pinned = Boolean(pinnedSourceId && articleId === pinnedSourceId);
    const semanticScore = semanticScores.get(articleId) ?? null;
    const title = normalizeKnowledgeText(article.title).slice(0, 240);
    const version = Math.max(Number(article.version || 1), 1);
    const updatedAtDate = new Date(article.updatedAt || 0);
    const updatedAt = Number.isNaN(updatedAtDate.getTime())
      ? ""
      : updatedAtDate.toISOString();
    const articleHash = String(
      article.contentHash ||
        createHash("sha256")
          .update(
            [
              KNOWLEDGE_INDEX_VERSION,
              title,
              article.summary,
              translationFor(article, locale) || article.content,
              article.transcript,
              JSON.stringify(article.customQuestions || []),
            ]
              .map((value) => normalizeKnowledgeText(value))
              .join("\n\n"),
          )
          .digest("hex"),
    ).slice(0, 64);

    const chunkCandidates = buildKnowledgeChunks(article, locale).map(
      (chunk) => ({
        chunk,
        lexical: lexicalScoreForChunk({
          article,
          chunk,
          terms,
          normalizedQuery,
        }),
      }),
    );
    if (containsPromptInjection(title)) continue;
    const representative = [...chunkCandidates].sort((left, right) => {
      const kindPriority: Record<KnowledgeChunk["kind"], number> = {
        summary: 4,
        faq: 3,
        content: 2,
        transcript: 1,
        metadata: 0,
      };
      return (
        right.lexical.score - left.lexical.score ||
        right.lexical.coverage - left.lexical.coverage ||
        kindPriority[right.chunk.kind] - kindPriority[left.chunk.kind] ||
        left.chunk.ordinal - right.chunk.ordinal
      );
    })[0]?.chunk;

    for (const { chunk, lexical } of chunkCandidates) {
      if (containsPromptInjection(chunk.content)) continue;
      const lexicalEligible = lexical.score >= 1.5 && lexical.coverage >= 0.34;
      // Article-wide vectors may discover a semantically relevant article,
      // but they are not evidence that every section is relevant. Admit one
      // representative section for semantic-only matches and require lexical
      // evidence for any additional chunk.
      const semanticEligible =
        semanticScore !== null &&
        semanticScore >= 0.68 &&
        (lexicalEligible || chunk.ordinal === representative?.ordinal);
      if (!pinned && !semanticEligible && !lexicalEligible) continue;
      const lexicalNormalized = Math.min(lexical.score / 24, 1);
      const semanticNormalized =
        semanticScore === null
          ? 0
          : Math.min(Math.max((semanticScore - 0.55) / 0.35, 0), 1);
      const chunkHash = createHash("sha256")
        .update(
          `${articleHash}:${chunk.kind}:${chunk.ordinal}:${chunk.content}`,
        )
        .digest("hex");
      const chunkId = `${articleId}:${version}:${chunk.ordinal}:${chunkHash.slice(0, 12)}`;
      const score =
        (pinned ? 10 : 0) +
        lexicalNormalized * 0.72 +
        semanticNormalized * 0.28 +
        lexical.coverage * 0.15;
      scored.push({
        id: chunkId,
        resourceId: articleId,
        chunkId,
        title,
        content: chunk.content,
        excerpt: chunk.content.replace(/\s+/g, " ").slice(0, 420),
        type: String(article.type || "guide"),
        category: String(article.category || "general"),
        audience: String(article.audience || "staff"),
        locale,
        sourceUrl: safeKnowledgeSourceUrl(article),
        sourceHref: knowledgeSourceHref(context, article),
        version,
        contentHash: articleHash,
        updatedAt,
        retrievedAt,
        score,
        lexicalScore: lexical.score,
        semanticScore,
        kind: chunk.kind,
        pinned,
        termCoverage: lexical.coverage,
      });
    }
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.lexicalScore - left.lexicalScore ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
  const selected: RetrievedKnowledgeSource[] = [];
  const perArticle = new Map<string, number>();
  for (const source of scored) {
    if ((perArticle.get(source.resourceId) || 0) >= 2) continue;
    const { termCoverage: _termCoverage, ...publicSource } = source;
    selected.push(publicSource);
    perArticle.set(
      source.resourceId,
      (perArticle.get(source.resourceId) || 0) + 1,
    );
    if (selected.length >= Math.min(Math.max(limit, 1), 20)) break;
  }

  const top = selected[0];
  const confidence = !top
    ? KNOWLEDGE_RETRIEVAL_CONFIDENCE.INSUFFICIENT
    : top.lexicalScore >= 10 ||
        (top.semanticScore !== null && top.semanticScore >= 0.78)
      ? KNOWLEDGE_RETRIEVAL_CONFIDENCE.HIGH
      : KNOWLEDGE_RETRIEVAL_CONFIDENCE.MEDIUM;
  const semanticReadyCount = embeddedQuery
    ? semanticScores.size
    : semanticArticles.length;
  return {
    sources: selected,
    coverage: {
      status: selected.length
        ? KNOWLEDGE_RETRIEVAL_STATUS.MATCHED
        : KNOWLEDGE_RETRIEVAL_STATUS.NO_MATCH,
      mode:
        embeddedQuery && semanticScores.size > 0
          ? KNOWLEDGE_RETRIEVAL_MODE.HYBRID
          : KNOWLEDGE_RETRIEVAL_MODE.LEXICAL,
      confidence,
      indexStatus:
        semanticReadyCount === 0
          ? "unavailable"
          : semanticReadyCount === articles.length
            ? "ready"
            : "partial",
      candidateCount: articles.length,
      semanticCandidateCount: semanticReadyCount,
      returnedCount: selected.length,
      truncated: articles.length >= KNOWLEDGE_RETRIEVAL_CANDIDATE_LIMIT,
      locale,
      retrievedAt,
    },
  };
};

export const indexKnowledgeArticle = async (
  articleId: string,
): Promise<void> => {
  const article: any = await CommunicationKnowledgeArticleModel.findById(
    articleId,
  )
    .select(
      "tenantId title summary content transcript customQuestions translations status deletedAt aiEnabled version embeddingStatus embeddingModel embeddingIndexVersion contentHash",
    )
    .exec();
  if (!article) return;
  const articleVersion = Math.max(Number(article.version || 1), 1);
  const questions = (article.customQuestions || [])
    .map(
      (entry: any) =>
        `${String(entry?.question || "")}\n${String(entry?.answer || "")}`,
    )
    .join("\n\n");
  const content = [
    article.title,
    article.summary,
    article.content,
    article.transcript,
    questions,
    JSON.stringify(article.translations || {}),
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const embeddingInput = content.slice(0, 30_000);
  const contentHash = createHash("sha256")
    .update(`${KNOWLEDGE_INDEX_VERSION}\n${normalizeKnowledgeText(content)}`)
    .digest("hex");
  if (
    article.deletedAt ||
    article.status !== "published" ||
    article.aiEnabled === false
  ) {
    const reason =
      article.aiEnabled === false
        ? "Article is disabled for AI."
        : "Article is not published.";
    await CommunicationKnowledgeArticleModel.updateOne(
      { _id: articleId, version: articleVersion },
      {
        $set: {
          contentHash,
          embeddingIndexVersion: KNOWLEDGE_INDEX_VERSION,
          embeddingStatus: "skipped",
          embeddingError: reason,
          embeddedAt: null,
          embeddingRetryable: false,
          nextEmbeddingAttemptAt: null,
        },
        $unset: { embeddingVector: 1 },
      },
    );
    return;
  }
  if (containsPromptInjection(content)) {
    await CommunicationKnowledgeArticleModel.updateOne(
      { _id: articleId, version: articleVersion },
      {
        $set: {
          contentHash,
          embeddingIndexVersion: KNOWLEDGE_INDEX_VERSION,
          embeddingStatus: "skipped",
          embeddingError:
            "Content contains instruction-like text and requires review before AI use.",
          embeddedAt: null,
          embeddingRetryable: false,
          nextEmbeddingAttemptAt: null,
        },
        $unset: { embeddingVector: 1 },
      },
    );
    return;
  }
  if (
    article.contentHash === contentHash &&
    article.embeddingStatus === "ready" &&
    article.embeddingModel === KNOWLEDGE_EMBEDDING_MODEL &&
    article.embeddingIndexVersion === KNOWLEDGE_INDEX_VERSION
  )
    return;

  if (!isOpenAiConfigured()) {
    await CommunicationKnowledgeArticleModel.updateOne(
      { _id: articleId, version: articleVersion },
      {
        $set: {
          contentHash,
          embeddingIndexVersion: KNOWLEDGE_INDEX_VERSION,
          embeddingStatus: "skipped",
          embeddingError: "OpenAI is not configured.",
          embeddedAt: null,
          embeddingRetryable: true,
          nextEmbeddingAttemptAt: nextConfigurationRetryAt(),
        },
        $unset: { embeddingVector: 1 },
      },
    );
    return;
  }

  try {
    await requireAiEntitlement(
      String(article.tenantId),
      "knowledgeBaseEnabled",
    );
  } catch {
    await CommunicationKnowledgeArticleModel.updateOne(
      { _id: articleId, version: articleVersion },
      {
        $set: {
          contentHash,
          embeddingIndexVersion: KNOWLEDGE_INDEX_VERSION,
          embeddingStatus: "skipped",
          embeddingError: "AI entitlement is unavailable.",
          embeddedAt: null,
          embeddingRetryable: true,
          nextEmbeddingAttemptAt: nextConfigurationRetryAt(),
        },
        $unset: { embeddingVector: 1 },
      },
    );
    return;
  }

  const staleProcessing = new Date(Date.now() - 15 * 60_000);
  const claimed = await CommunicationKnowledgeArticleModel.findOneAndUpdate(
    {
      _id: articleId,
      version: articleVersion,
      status: "published",
      deletedAt: null,
      aiEnabled: { $ne: false },
      $or: [
        { contentHash: { $ne: contentHash } },
        { embeddingModel: { $ne: KNOWLEDGE_EMBEDDING_MODEL } },
        { embeddingIndexVersion: { $ne: KNOWLEDGE_INDEX_VERSION } },
        { embeddingStatus: { $in: ["pending", "failed", "skipped"] } },
        { embeddingStatus: "processing", updatedAt: { $lt: staleProcessing } },
      ],
    },
    {
      $set: {
        embeddingStatus: "processing",
        embeddingIndexVersion: KNOWLEDGE_INDEX_VERSION,
        contentHash,
        embeddingError: "",
        embeddingRetryable: true,
        nextEmbeddingAttemptAt: null,
      },
      $inc: { embeddingAttempts: 1 },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return;

  let reservation: any;
  try {
    reservation = await reserveAiCredits({
      tenantId: String(article.tenantId),
      feature: AI_FEATURE.KNOWLEDGE_EMBEDDING,
      idempotencyKey: `knowledge:${articleId}:${contentHash}`,
      credits: Math.max(3, Math.ceil(embeddingInput.length / 2_000)),
    });
  } catch (error) {
    await CommunicationKnowledgeArticleModel.updateOne(
      {
        _id: articleId,
        version: articleVersion,
        contentHash,
        embeddingStatus: "processing",
      },
      {
        $set: {
          embeddingStatus: "pending",
          embeddingError: "Embedding credits are temporarily unavailable.",
          embeddingRetryable: true,
          nextEmbeddingAttemptAt: nextEmbeddingRetryAt(
            Number(claimed.embeddingAttempts || 1),
          ),
        },
      },
    );
    throw error;
  }
  try {
    const result = await createEmbedding(embeddingInput);
    await CommunicationKnowledgeArticleModel.updateOne(
      { _id: articleId, version: articleVersion, contentHash },
      {
        $set: {
          embeddingStatus: "ready",
          embeddingModel: result.model,
          embeddingIndexVersion: KNOWLEDGE_INDEX_VERSION,
          embeddingVector: result.vector,
          embeddedAt: new Date(),
          embeddingError: "",
          embeddingAttempts: 0,
          embeddingRetryable: false,
          nextEmbeddingAttemptAt: null,
        },
      },
    );
    await settleAiCredits({
      reservationId: String(reservation._id),
      usage: result.usage,
      model: result.model,
    });
  } catch (error) {
    await releaseAiCredits(String(reservation._id));
    await CommunicationKnowledgeArticleModel.updateOne(
      { _id: articleId, version: articleVersion, contentHash },
      {
        $set: {
          embeddingStatus: "failed",
          embeddingError:
            error instanceof Error
              ? error.message.slice(0, 1_000)
              : "Embedding failed.",
          embeddingRetryable: true,
          nextEmbeddingAttemptAt: nextEmbeddingRetryAt(
            Number(claimed.embeddingAttempts || 1),
          ),
        },
      },
    );
    logger.warn({ err: error, articleId }, "Knowledge embedding failed.");
  }
};

/** Recovery worker for pending or interrupted embedding jobs. */
export const processPendingKnowledgeEmbeddings = async (
  limit = 25,
): Promise<{ processed: number }> => {
  const staleProcessing = new Date(Date.now() - 15 * 60_000);
  const now = new Date();
  const articles = await CommunicationKnowledgeArticleModel.find({
    deletedAt: null,
    status: "published",
    aiEnabled: { $ne: false },
    $or: [
      {
        embeddingStatus: "pending",
        $or: [
          { nextEmbeddingAttemptAt: null },
          { nextEmbeddingAttemptAt: { $exists: false } },
          { nextEmbeddingAttemptAt: { $lte: now } },
        ],
      },
      { embeddingStatus: "processing", updatedAt: { $lt: staleProcessing } },
      {
        embeddingStatus: { $in: ["failed", "skipped"] },
        embeddingRetryable: { $ne: false },
        $or: [
          { nextEmbeddingAttemptAt: { $lte: now } },
          {
            nextEmbeddingAttemptAt: { $exists: false },
            updatedAt: { $lt: staleProcessing },
          },
        ],
      },
      {
        embeddingStatus: "ready",
        embeddingIndexVersion: { $ne: KNOWLEDGE_INDEX_VERSION },
      },
      {
        embeddingStatus: "ready",
        embeddingModel: { $ne: KNOWLEDGE_EMBEDDING_MODEL },
      },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(Math.min(Math.max(Math.floor(limit), 1), 100))
    .select("_id")
    .lean();
  for (const article of articles) {
    try {
      await indexKnowledgeArticle(String(article._id));
    } catch (error) {
      logger.warn(
        { err: error, articleId: String(article._id) },
        "Pending knowledge embedding could not be processed.",
      );
    }
  }
  return { processed: articles.length };
};

export const knowledgeRetrievalService = {
  buildQuery: buildKnowledgeRetrievalQuery,
  audiencesForContext,
  retrieve: retrieveKnowledge,
  indexArticle: indexKnowledgeArticle,
  processPending: processPendingKnowledgeEmbeddings,
};
