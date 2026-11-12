export const NOTIFICATION_CHANNEL = {
  EMAIL: "EMAIL",
} as const;

export type NotificationChannel =
  (typeof NOTIFICATION_CHANNEL)[keyof typeof NOTIFICATION_CHANNEL];

export const NOTIFICATION_STATUS = {
  PENDING: "PENDING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;

export type NotificationStatus =
  (typeof NOTIFICATION_STATUS)[keyof typeof NOTIFICATION_STATUS];

export const EMAIL_NOTIFICATION_RECIPIENT_STATUS = {
  SENT: "SENT",
  FAILED: "FAILED",
} as const;

export type EmailNotificationRecipientStatus =
  (typeof EMAIL_NOTIFICATION_RECIPIENT_STATUS)[keyof typeof EMAIL_NOTIFICATION_RECIPIENT_STATUS];

export const EMAIL_NOTIFICATION_TYPE = {
  BULK_EMAIL: "bulk-email",
  GENERAL: "general",
} as const;

export type EmailNotificationType =
  (typeof EMAIL_NOTIFICATION_TYPE)[keyof typeof EMAIL_NOTIFICATION_TYPE];

export const DEFAULT_NOTIFICATION_PAGE = 1;
export const DEFAULT_NOTIFICATION_LIMIT = 50;
export const MAX_NOTIFICATION_LIMIT = 100;

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DEFAULT_DEADLINE_DAYS = 24;

export const BULK_NOTIFICATION_LIMITS = Object.freeze({
  MAX_RECIPIENTS: 50,
  MAX_FILES: 10,
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_AGGREGATE_FILE_BYTES: 8 * 1024 * 1024,
  MAX_MULTIPART_FIELDS: 4,
  MAX_MULTIPART_FIELD_BYTES: 256 * 1024,
  MAX_CONCURRENCY: 4,
});

export const BULK_NOTIFICATION_ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
