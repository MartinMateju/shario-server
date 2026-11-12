import { DEFAULT_STUDIO_COMMERCE_CURRENCY } from "@/shared/money/currency.js";

export const MEMBERSHIP_PLAN_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
  ARCHIVED: "archived",
} as const;

export const MEMBERSHIP_PLAN_VERSION_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
} as const;

export const MEMBERSHIP_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  PAUSED: "paused",
  CANCEL_SCHEDULED: "cancel_scheduled",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
} as const;

export const OPEN_MEMBERSHIP_STATUSES = Object.freeze([
  MEMBERSHIP_STATUS.PENDING,
  MEMBERSHIP_STATUS.ACTIVE,
  MEMBERSHIP_STATUS.PAST_DUE,
  MEMBERSHIP_STATUS.PAUSED,
  MEMBERSHIP_STATUS.CANCEL_SCHEDULED,
]);

export const MEMBERSHIP_LOCATION_SCOPE = {
  ALL: "all",
  SELECTED: "selected",
  SHARED_SELECTED: "shared_selected",
} as const;

export const MEMBERSHIP_BILLING_INTERVAL = {
  MONTH: "month",
  YEAR: "year",
} as const;

export const MEMBERSHIP_BILLING_TYPE = {
  RECURRING: "recurring",
  FIXED: "fixed",
} as const;

export const MEMBERSHIP_BENEFIT_TYPE = {
  ALLOWANCE: "allowance",
  PERCENTAGE: "percentage",
  LIMIT: "limit",
  BOOLEAN: "boolean",
} as const;

export const MEMBERSHIP_ALLOWANCE_UNIT = {
  CREDIT: "credit",
  VISIT: "visit",
  SESSION: "session",
  MINUTE: "minute",
  HOUR: "hour",
  BOOKING: "booking",
  ITEM: "item",
  MONEY_MINOR: "money_minor",
  CUSTOM: "custom",
} as const;

export const MEMBERSHIP_PERCENTAGE_APPLIES_TO = {
  BOOKINGS: "bookings",
  PRODUCTS: "products",
  ALL: "all",
} as const;

export const MEMBERSHIP_LIMIT_UNIT = {
  ACTIVE_BOOKINGS: "active_bookings",
  PRIORITY_DAYS: "priority_days",
  CUSTOM: "custom",
} as const;

export const MEMBERSHIP_LEDGER_ENTRY_TYPE = {
  GRANT: "grant",
  ADJUSTMENT: "adjustment",
  REDEMPTION: "redemption",
  REVERSAL: "reversal",
  EXPIRATION: "expiration",
} as const;

/** Explicitly allowed operational adjustment reasons. */
export const MEMBERSHIP_ADJUSTMENT_REASON = {
  MANUAL_CORRECTION: "manual_correction",
  SERVICE_RECOVERY: "service_recovery",
  PROMOTION: "promotion",
  MIGRATION: "migration",
} as const;

export const MEMBERSHIP_ASSIGNMENT_REASON = {
  PAID_OFFLINE: "paid_offline",
  COMPLIMENTARY: "complimentary",
  MIGRATION: "migration",
  MANUAL_CORRECTION: "manual_correction",
} as const;

export const MEMBERSHIP_CANCELLATION_REASON = {
  TOO_EXPENSIVE: "too_expensive",
  NOT_USING: "not_using",
  MISSING_FEATURES: "missing_features",
  MOVING: "moving",
  TEMPORARY: "temporary",
  OTHER: "other",
} as const;

export const MEMBERSHIP_CANCELLATION_EFFECTIVE = {
  IMMEDIATE: "immediate",
  PERIOD_END: "period_end",
} as const;

export const MEMBERSHIP_WEBHOOK_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  PROCESSED: "processed",
  FAILED: "failed",
} as const;

export const MEMBERSHIP_INVOICE_STATUS = {
  DRAFT: "draft",
  OPEN: "open",
  PAID: "paid",
  VOID: "void",
  UNCOLLECTIBLE: "uncollectible",
} as const;

export type MembershipStatus =
  (typeof MEMBERSHIP_STATUS)[keyof typeof MEMBERSHIP_STATUS];

export const DEFAULT_MEMBERSHIP_CURRENCY = DEFAULT_STUDIO_COMMERCE_CURRENCY;
export const DEFAULT_CREDITS_EXPIRE_AFTER_DAYS = 31;
export const DEFAULT_MEMBERSHIP_RENEWAL_DAYS = 31;
export const DEFAULT_MEMBERSHIP_PAGE = 1;
export const DEFAULT_MEMBERSHIP_LIMIT = 50;
export const MAX_MEMBERSHIP_LIMIT = 100;
export const MEMBERSHIP_WEBHOOK_LEASE_MS = 5 * 60 * 1000;
export const MEMBERSHIP_RECONCILIATION_BATCH_SIZE = 100;
export const MAX_MEMBERSHIP_BENEFIT_ADJUSTMENT = 1_000_000;
