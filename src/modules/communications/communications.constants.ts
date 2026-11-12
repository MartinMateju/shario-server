export const COMMUNICATION_CHANNEL = {
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  INSTAGRAM: "instagram",
  IN_APP: "in_app",
} as const;
export const COMMUNICATION_CHANNELS = Object.values(COMMUNICATION_CHANNEL);

export const CONVERSATION_STATUS = {
  OPEN: "open",
  PENDING: "pending",
  SNOOZED: "snoozed",
  CLOSED: "closed",
} as const;
export const CONVERSATION_STATUSES = Object.values(CONVERSATION_STATUS);

export const CONVERSATION_PRIORITY = {
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  URGENT: "urgent",
} as const;
export const CONVERSATION_PRIORITIES = Object.values(CONVERSATION_PRIORITY);

export const CONVERSATION_CATEGORY = {
  BOOKING_ENQUIRY: "booking_enquiry",
  BOOKING_CHANGE: "booking_change",
  CANCELLATION: "cancellation",
  COURSE_ENQUIRY: "course_enquiry",
  PAYMENT_PROBLEM: "payment_problem",
  INVOICE_REQUEST: "invoice_request",
  MEMBERSHIP_CREDITS: "membership_credits",
  ACCESS_PROBLEM: "access_problem",
  PICKUP_REQUEST: "pickup_request",
  COMPLAINT: "complaint",
  GENERAL: "general",
  SPAM: "spam",
  OTHER: "other",
} as const;
export const CONVERSATION_CATEGORIES = Object.values(CONVERSATION_CATEGORY);

export const MESSAGE_DIRECTION = {
  INCOMING: "incoming",
  OUTGOING: "outgoing",
  INTERNAL: "internal",
  SYSTEM: "system",
} as const;
export const MESSAGE_DIRECTIONS = Object.values(MESSAGE_DIRECTION);

export const MESSAGE_KIND = {
  TEXT: "text",
  HTML: "html",
  VOICE: "voice",
  NOTE: "note",
  SYSTEM: "system",
} as const;
export const MESSAGE_KINDS = Object.values(MESSAGE_KIND);

export const DELIVERY_STATUS = {
  QUEUED: "queued",
  SENDING: "sending",
  AMBIGUOUS: "ambiguous",
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
  BOUNCED: "bounced",
  COMPLAINED: "complained",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
} as const;
export const DELIVERY_STATUSES = Object.values(DELIVERY_STATUS);
export const TERMINAL_DELIVERY_STATUSES = [
  DELIVERY_STATUS.AMBIGUOUS,
  DELIVERY_STATUS.DELIVERED,
  DELIVERY_STATUS.READ,
  DELIVERY_STATUS.BOUNCED,
  DELIVERY_STATUS.COMPLAINED,
  DELIVERY_STATUS.REJECTED,
  DELIVERY_STATUS.CANCELLED,
] as const;

export const CONSENT_PURPOSE = {
  TRANSACTIONAL: "transactional",
  MARKETING: "marketing",
  SUPPORT: "support",
  SECURITY: "security",
} as const;
export const CONSENT_PURPOSES = Object.values(CONSENT_PURPOSE);

export const CONSENT_STATUS = {
  GRANTED: "granted",
  REVOKED: "revoked",
  UNKNOWN: "unknown",
} as const;
export const CONSENT_STATUSES = Object.values(CONSENT_STATUS);

export const AI_ANALYSIS_STATUS = {
  PENDING: "pending",
  COMPLETED: "completed",
  NEEDS_REVIEW: "needs_review",
  FAILED: "failed",
  DISABLED: "disabled",
} as const;

export const KNOWLEDGE_ARTICLE_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
  ARCHIVED: "archived",
} as const;
export const KNOWLEDGE_ARTICLE_STATUSES = Object.values(
  KNOWLEDGE_ARTICLE_STATUS,
);

export const KNOWLEDGE_ARTICLE_AUDIENCE = {
  PUBLIC: "public",
  CUSTOMER: "customer",
  MEMBER: "member",
  COURSE: "course",
  STAFF: "staff",
  OWNER: "owner",
} as const;
export const KNOWLEDGE_ARTICLE_AUDIENCES = Object.values(
  KNOWLEDGE_ARTICLE_AUDIENCE,
);

export const KNOWLEDGE_ARTICLE_TYPE = {
  VIDEO: "video",
  GUIDE: "guide",
  FAQ: "faq",
  LINK: "link",
  FILE: "file",
} as const;
export const KNOWLEDGE_ARTICLE_TYPES = Object.values(KNOWLEDGE_ARTICLE_TYPE);

export const KNOWLEDGE_EMBEDDING_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  READY: "ready",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;
export const KNOWLEDGE_EMBEDDING_STATUSES = Object.values(
  KNOWLEDGE_EMBEDDING_STATUS,
);

export const ROUTING_MATCH_OPERATOR = {
  ALL: "all",
  ANY: "any",
} as const;
export const ROUTING_MATCH_OPERATORS = Object.values(ROUTING_MATCH_OPERATOR);

export const AUDIT_ACTION = {
  CREATED: "created",
  UPDATED: "updated",
  VIEWED: "viewed",
  ASSIGNED: "assigned",
  MESSAGE_SENT: "message_sent",
  MESSAGE_RECEIVED: "message_received",
  NOTE_ADDED: "note_added",
  AI_ANALYZED: "ai_analyzed",
  AI_DRAFTED: "ai_drafted",
  TRANSLATED: "translated",
  TRANSCRIBED: "transcribed",
  TASK_CREATED: "task_created",
  DELIVERY_RETRIED: "delivery_retried",
  DELIVERY_FAILED: "delivery_failed",
  CONSENT_CHANGED: "consent_changed",
  EXPORTED: "exported",
  DELETED: "deleted",
  RETENTION_PURGED: "retention_purged",
  CSAT_RECEIVED: "csat_received",
} as const;

export const DEFAULT_COMMUNICATION_PAGE_SIZE = 30;
export const MAX_COMMUNICATION_PAGE_SIZE = 100;
export const DEFAULT_RETENTION_DAYS = 730;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 4;
export const MAX_DELIVERY_ATTEMPTS = 8;
export const AI_AUTO_APPLY_CONFIDENCE = 0.9;
export const AI_REVIEW_CONFIDENCE = 0.7;

export type CommunicationChannel =
  (typeof COMMUNICATION_CHANNEL)[keyof typeof COMMUNICATION_CHANNEL];
export type ConversationStatus =
  (typeof CONVERSATION_STATUS)[keyof typeof CONVERSATION_STATUS];
export type ConversationPriority =
  (typeof CONVERSATION_PRIORITY)[keyof typeof CONVERSATION_PRIORITY];
export type ConversationCategory =
  (typeof CONVERSATION_CATEGORY)[keyof typeof CONVERSATION_CATEGORY];
export type DeliveryStatus =
  (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];
export type ConsentPurpose =
  (typeof CONSENT_PURPOSE)[keyof typeof CONSENT_PURPOSE];
