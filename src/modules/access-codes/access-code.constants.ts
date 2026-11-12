export const ACCESS_CODE_NOTIFICATION_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
  DELIVERY_UNKNOWN: "delivery_unknown",
  CANCELLED: "cancelled",
} as const;

export type AccessCodeNotificationStatus =
  (typeof ACCESS_CODE_NOTIFICATION_STATUS)[keyof typeof ACCESS_CODE_NOTIFICATION_STATUS];

export const ACCESS_CODE_NOTIFICATION_CHANNEL = {
  EMAIL: "email",
  SMS: "sms",
} as const;

export type AccessCodeNotificationChannel =
  (typeof ACCESS_CODE_NOTIFICATION_CHANNEL)[keyof typeof ACCESS_CODE_NOTIFICATION_CHANNEL];

export const ACCESS_CODE_PROVIDER = {
  POSTMARK: "postmark",
  SMTP: "smtp",
  GOSMS: "gosms",
  SYSTEM: "system",
} as const;

export type AccessCodeProvider =
  (typeof ACCESS_CODE_PROVIDER)[keyof typeof ACCESS_CODE_PROVIDER];

export const ACCESS_CODE_TYPE = {
  SINGLE_BOOKING: "single_booking",
  REUSABLE: "reusable",
  EMERGENCY_RESERVE: "emergency_reserve",
} as const;

export type AccessCodeType =
  (typeof ACCESS_CODE_TYPE)[keyof typeof ACCESS_CODE_TYPE];

export const ACCESS_CODE_STATUS = {
  DRAFT: "draft",
  AVAILABLE: "available",
  DISABLED: "disabled",
  RETIRED: "retired",
} as const;

export type AccessCodeStatus =
  (typeof ACCESS_CODE_STATUS)[keyof typeof ACCESS_CODE_STATUS];

export const ACCESS_CODE_EFFECTIVE_STATUS = {
  ...ACCESS_CODE_STATUS,
  EXPIRED: "expired",
} as const;

export type AccessCodeEffectiveStatus =
  (typeof ACCESS_CODE_EFFECTIVE_STATUS)[keyof typeof ACCESS_CODE_EFFECTIVE_STATUS];

export const ACCESS_CODE_SOURCE = {
  MANUAL: "manual",
  IMPORT: "import",
  LEGACY_MIGRATION: "legacy_migration",
} as const;

export const ACCESS_CODE_AUDIT_ACTION = {
  POOL_CREATED: "pool.created",
  POOL_UPDATED: "pool.updated",
  POOL_ARCHIVED: "pool.archived",
  CODE_CREATED: "code.created",
  CODE_IMPORTED: "code.imported",
  CODE_UPDATED: "code.updated",
  CODE_RETIRED: "code.retired",
  CODE_REVEALED: "code.revealed",
} as const;

export type AccessCodeAuditAction =
  (typeof ACCESS_CODE_AUDIT_ACTION)[keyof typeof ACCESS_CODE_AUDIT_ACTION];

export const ACCESS_CODE_BULK_LIMIT = 500;
export const DEFAULT_ACCESS_CODE_LOW_STOCK_THRESHOLD = 5;
export const DEFAULT_ACCESS_CODE_PAGE = 1;
export const DEFAULT_ACCESS_CODE_LIMIT = 50;
export const MAX_ACCESS_CODE_LIMIT = 100;
export const ACCESS_CODE_CIPHERTEXT_PREFIX = "v1";

export const DEFAULT_ACCESS_CODE_EXPIRY_DAYS = 365;
export const DEFAULT_ACCESS_CODE_SEND_MINUTES_BEFORE = 15;
export const ACCESS_CODE_MAX_LOOKAHEAD_MINUTES = 24 * 60;
export const ACCESS_CODE_BATCH_LIMIT = 50;
export const ACCESS_CODE_CANDIDATE_SCAN_LIMIT = 500;
export const ACCESS_CODE_PROCESSING_LEASE_MINUTES = 10;
export const ACCESS_CODE_RETRY_DELAY_MINUTES = 5;
export const ACCESS_CODE_MAX_ERROR_LENGTH = 1000;
export const ACCESS_CODE_LOCK_OWNER_PREFIX = "access-code";
