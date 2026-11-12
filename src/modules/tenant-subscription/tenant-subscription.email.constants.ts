import { APP_LOCALE } from "@/shared/i18n/locales.js";

export const TENANT_BILLING_EMAIL_TYPE = {
  TRIAL_ENDING: "trial_ending",
  PAYMENT_FAILED: "payment_failed",
  PAYMENT_ACTION_REQUIRED: "payment_action_required",
  PAYMENT_RECOVERED: "payment_recovered",
  PAYMENT_RECOVERY_ENDED: "payment_recovery_ended",
  INVOICE_FINALIZATION_FAILED: "invoice_finalization_failed",
} as const;

export const TENANT_BILLING_EMAIL_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
} as const;

export const TENANT_BILLING_EMAIL_LOCALE = {
  EN: APP_LOCALE.EN,
  CS: APP_LOCALE.CS,
  DE: APP_LOCALE.DE,
  PL: APP_LOCALE.PL,
  SK: APP_LOCALE.SK,
  DA: APP_LOCALE.DA,
  FR: APP_LOCALE.FR,
  ES: APP_LOCALE.ES,
  IT: APP_LOCALE.IT,
  PT_PT: APP_LOCALE.PT_PT,
  SV: APP_LOCALE.SV,
  NB: APP_LOCALE.NB,
  FI: APP_LOCALE.FI,
  HU: APP_LOCALE.HU,
  EL: APP_LOCALE.EL,
  TR: APP_LOCALE.TR,
  NL: APP_LOCALE.NL,
  RO: APP_LOCALE.RO,
} as const;

export const TENANT_TRIAL_REMINDER_DAYS = 3;
export const TENANT_BILLING_EMAIL_MAX_ATTEMPTS = 8;
export const TENANT_BILLING_EMAIL_PROCESSING_TIMEOUT_MINUTES = 10;
