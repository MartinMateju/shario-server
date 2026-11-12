export const TENANT_SUBSCRIPTION_STATUS = {
  PENDING: "pending",
  TRIALING: "trialing",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  UNPAID: "unpaid",
  PAUSED: "paused",
  EXPIRED: "expired",
  CANCELED: "canceled",
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
} as const;

export const BILLING_INTERVAL = {
  MONTHLY: "monthly",
  YEARLY: "yearly",
} as const;

export const SUBSCRIPTION_ACCESS_MODE = {
  SETUP: "setup",
  FULL: "full",
  GRACE: "grace",
  RESTRICTED: "restricted",
  BLOCKED: "blocked",
} as const;

export const TENANT_TRIAL_DAYS = 14;
export const PAYMENT_GRACE_DAYS = 7;

export const PAYMENT_FAILURE_REASON = {
  PAYMENT_FAILED: "payment_failed",
  ACTION_REQUIRED: "action_required",
  FINALIZATION_FAILED: "finalization_failed",
  MARKED_UNCOLLECTIBLE: "marked_uncollectible",
  VOIDED: "voided",
} as const;

export const STRIPE_EVENT_PROCESSING_TIMEOUT_MINUTES = 5;
