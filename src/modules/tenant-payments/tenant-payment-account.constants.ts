import { APP_LOCALE } from "@/shared/i18n/locales.js";

export const TENANT_PAYMENT_ONBOARDING_STATUS = {
  NOT_STARTED: "not_started",
  PENDING: "pending",
  RESTRICTED: "restricted",
  COMPLETE: "complete",
} as const;

export const TENANT_PAYMENT_DASHBOARD_TYPE = {
  FULL: "full",
} as const;

export const TENANT_PAYMENT_CONTROLLER = Object.freeze({
  feesPayer: "account",
  lossesPayments: "stripe",
  requirementCollection: "stripe",
  dashboardType: TENANT_PAYMENT_DASHBOARD_TYPE.FULL,
} as const);

export const TENANT_PAYMENT_CONNECT_LOCALE = {
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

export const TENANT_PAYMENT_CONNECT_LOCALES = Object.freeze(
  Object.values(TENANT_PAYMENT_CONNECT_LOCALE),
);

export const STRIPE_FULL_DASHBOARD_URL = "https://dashboard.stripe.com/";

/**
 * Account creation idempotency records are intentionally not automatically
 * retried after Stripe's 24-hour idempotency window. Doing so could create a
 * second financial account for the same legal seller after a process crash.
 */
export const CONNECT_ACCOUNT_AUTOMATIC_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
