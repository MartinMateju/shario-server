import type { AiLocale } from "./ai-locale.js";

export const KNOWLEDGE_RETRIEVAL_STATUS = {
  MATCHED: "matched",
  NO_MATCH: "no_match",
  DISABLED: "disabled",
  UNAVAILABLE: "unavailable",
} as const;

export const KNOWLEDGE_RETRIEVAL_MODE = {
  HYBRID: "hybrid",
  LEXICAL: "lexical",
} as const;

export const KNOWLEDGE_RETRIEVAL_CONFIDENCE = {
  HIGH: "high",
  MEDIUM: "medium",
  INSUFFICIENT: "insufficient",
} as const;

export type KnowledgeRetrievalStatus =
  (typeof KNOWLEDGE_RETRIEVAL_STATUS)[keyof typeof KNOWLEDGE_RETRIEVAL_STATUS];

export type KnowledgeRetrievalMode =
  (typeof KNOWLEDGE_RETRIEVAL_MODE)[keyof typeof KNOWLEDGE_RETRIEVAL_MODE];

export type KnowledgeRetrievalConfidence =
  (typeof KNOWLEDGE_RETRIEVAL_CONFIDENCE)[keyof typeof KNOWLEDGE_RETRIEVAL_CONFIDENCE];

export type RetrievedKnowledgeSource = {
  /** Opaque, immutable key supplied to the model for citation. */
  id: string;
  resourceId: string;
  chunkId: string;
  title: string;
  content: string;
  excerpt: string;
  type: string;
  category: string;
  audience: string;
  locale: AiLocale;
  sourceUrl: string;
  sourceHref: string;
  version: number;
  contentHash: string;
  updatedAt: string;
  retrievedAt: string;
  score: number;
  lexicalScore: number;
  semanticScore: number | null;
  kind: "metadata" | "summary" | "content" | "transcript" | "faq";
  pinned: boolean;
};

export type KnowledgeRetrievalCoverage = {
  status: KnowledgeRetrievalStatus;
  mode: KnowledgeRetrievalMode;
  confidence: KnowledgeRetrievalConfidence;
  indexStatus: "ready" | "partial" | "unavailable";
  candidateCount: number;
  semanticCandidateCount: number;
  returnedCount: number;
  truncated: boolean;
  locale: AiLocale;
  retrievedAt: string;
};

export type KnowledgeRetrievalResult = {
  sources: RetrievedKnowledgeSource[];
  coverage: KnowledgeRetrievalCoverage;
};
