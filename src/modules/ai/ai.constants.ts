export const AI_AUDIENCE = {
  WORKSPACE: "workspace",
  CUSTOMER: "customer",
  PUBLIC: "public",
  SYSTEM: "system",
} as const;

export const AI_AUDIENCES = Object.values(AI_AUDIENCE);

export const AI_FEATURE = {
  COMMUNICATION_ANALYSIS: "communication_analysis",
  COMMUNICATION_DRAFT: "communication_draft",
  TRANSLATION: "translation",
  TRANSCRIPTION: "transcription",
  STUDIO_ASSISTANT: "studio_assistant",
  DAILY_BRIEFING: "daily_briefing",
  BUSINESS_ADVISOR: "business_advisor",
  REPORT_INSIGHTS: "report_insights",
  STAFF_PLANNING: "staff_planning",
  CUSTOMER_CONCIERGE: "customer_concierge",
  PUBLIC_CONCIERGE: "public_concierge",
  FIRING_INTELLIGENCE: "firing_intelligence",
  KNOWLEDGE_RETRIEVAL: "knowledge_retrieval",
  KNOWLEDGE_EMBEDDING: "knowledge_embedding",
} as const;

export const AI_FEATURES = Object.values(AI_FEATURE);

export const AI_RUN_STATUS = {
  PENDING: "pending",
  COMPLETED: "completed",
  FALLBACK: "fallback",
  REFUSED: "refused",
  FAILED: "failed",
} as const;

export const AI_USAGE_STATUS = {
  RESERVED: "reserved",
  SETTLED: "settled",
  RELEASED: "released",
} as const;

export const AI_CONVERSATION_STATUS = {
  ACTIVE: "active",
  ARCHIVED: "archived",
} as const;

export const AI_ACTION_STATUS = {
  SUGGESTED: "suggested",
  EXECUTING: "executing",
  COMPLETED: "completed",
  DISMISSED: "dismissed",
  FAILED: "failed",
  EXPIRED: "expired",
} as const;

export const AI_ACTION_KEY = {
  CREATE_TASK: "create_task",
  COMPLETE_TASK: "complete_task",
  CREATE_INVENTORY_REORDER_REQUEST: "create_inventory_reorder_request",
  CREATE_EVENT: "create_event",
} as const;

export const AI_ACTION_RISK = {
  LOW: "low",
  MEDIUM: "medium",
} as const;

export const AI_ACTION_EVENT = {
  SUGGESTED: "suggested",
  CONFIRMED: "confirmed",
  DISMISSED: "dismissed",
  COMPLETED: "completed",
  FAILED: "failed",
  EXPIRED: "expired",
  RECOVERED: "recovered",
} as const;

export const AI_KNOWLEDGE_AUDIENCE = {
  PUBLIC: "public",
  CUSTOMER: "customer",
  MEMBER: "member",
  COURSE: "course",
  STAFF: "staff",
  OWNER: "owner",
} as const;

export const AI_KNOWLEDGE_AUDIENCES = Object.values(AI_KNOWLEDGE_AUDIENCE);

export const AI_EMBEDDING_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  READY: "ready",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

export const AI_FEEDBACK_RATING = {
  HELPFUL: "helpful",
  NOT_HELPFUL: "not_helpful",
} as const;

export const AI_PROMPT_VERSION = {
  ASSISTANT: "studio-assistant-v16",
  BRIEFING: "daily-briefing-v3",
  BUSINESS_ADVISOR: "business-advisor-v2",
  REPORT_INSIGHTS: "report-insights-v1",
  STAFF_PLANNING: "staff-planning-v1",
  CONCIERGE: "studio-concierge-v4",
  FIRING: "firing-intelligence-v1",
  COMMUNICATION_ANALYSIS: "communication-analysis-v2",
  COMMUNICATION_DRAFT: "communication-draft-v2",
  TRANSLATION: "translation-v2",
} as const;

/**
 * Credits are reserved before a provider request. Actual provider token use is
 * settled afterwards (one credit per 1,000 tokens, with a feature minimum).
 * Reserving a conservative ceiling prevents concurrent requests from passing
 * the same monthly quota.
 */
export const AI_FEATURE_CREDIT_RESERVATION: Record<string, number> = {
  [AI_FEATURE.COMMUNICATION_ANALYSIS]: 4,
  [AI_FEATURE.COMMUNICATION_DRAFT]: 8,
  [AI_FEATURE.TRANSLATION]: 4,
  [AI_FEATURE.TRANSCRIPTION]: 8,
  [AI_FEATURE.STUDIO_ASSISTANT]: 10,
  [AI_FEATURE.DAILY_BRIEFING]: 10,
  [AI_FEATURE.BUSINESS_ADVISOR]: 10,
  [AI_FEATURE.REPORT_INSIGHTS]: 10,
  [AI_FEATURE.STAFF_PLANNING]: 10,
  [AI_FEATURE.CUSTOMER_CONCIERGE]: 8,
  [AI_FEATURE.PUBLIC_CONCIERGE]: 6,
  [AI_FEATURE.FIRING_INTELLIGENCE]: 10,
  [AI_FEATURE.KNOWLEDGE_RETRIEVAL]: 1,
  [AI_FEATURE.KNOWLEDGE_EMBEDDING]: 3,
};

export const DEFAULT_AI_PAGE_SIZE = 30;
export const MAX_AI_PAGE_SIZE = 100;
export const MAX_AI_MESSAGE_LENGTH = 10_000;
export const MAX_PUBLIC_AI_MESSAGE_LENGTH = 2_000;
export const MAX_AI_CONVERSATION_MESSAGES = 80;
export const PUBLIC_AI_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const AI_ACTION_SCHEMA_VERSION = "ai-command-v1";
export const AI_ACTION_TTL_MS = 15 * 60 * 1000;
export const AI_ACTION_EXECUTION_LEASE_MS = 60 * 1000;
export const AI_CREDITS_PER_TOKEN_BLOCK = 1_000;

export type AiAudience = (typeof AI_AUDIENCE)[keyof typeof AI_AUDIENCE];
export type AiFeature = (typeof AI_FEATURE)[keyof typeof AI_FEATURE];
export type AiKnowledgeAudience =
  (typeof AI_KNOWLEDGE_AUDIENCE)[keyof typeof AI_KNOWLEDGE_AUDIENCE];

