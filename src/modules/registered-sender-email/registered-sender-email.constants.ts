export const REGISTERED_SENDER_PROVIDER = {
  POSTMARK_MANAGED: "postmark_managed",
  CUSTOM: "custom",
  GMAIL: "gmail",
  OUTLOOK: "outlook",
  SEZNAM: "seznam",
  RESEND: "resend",
  SMTP2GO: "smtp2go",
} as const;

export type RegisteredSenderProvider =
  (typeof REGISTERED_SENDER_PROVIDER)[keyof typeof REGISTERED_SENDER_PROVIDER];

export const REGISTERED_SENDER_PROVIDERS = Object.values(
  REGISTERED_SENDER_PROVIDER,
);

export const SENDER_TEST_STATUS = {
  UNTESTED: "untested",
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
} as const;

export type SenderTestStatus =
  (typeof SENDER_TEST_STATUS)[keyof typeof SENDER_TEST_STATUS];

export const SENDER_TEST_STATUSES = Object.values(SENDER_TEST_STATUS);

export const ACTIVE_AUTOMATION_STATUSES = [
  "active",
  "waiting_to_activate",
  "pending",
] as const;

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MANAGED_SENDER_PROVISIONING_ERROR_FALLBACK =
  "MANAGED_EMAIL_PROVISIONING_FAILED";

export const MANAGED_SENDER_PROVISIONING_ERROR_CODE_REGEX =
  /^[A-Z][A-Z0-9_]{2,79}$/;

export const MANAGED_SENDER_READINESS = {
  PROVISIONING: "provisioning",
  REPLY_TO_PENDING: "reply_to_pending",
  READY: "ready",
  DISABLED: "disabled",
  ERROR: "error",
} as const;

export type ManagedSenderReadiness =
  (typeof MANAGED_SENDER_READINESS)[keyof typeof MANAGED_SENDER_READINESS];
