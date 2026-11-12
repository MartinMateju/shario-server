export const WAITLIST_STATE = {
  WAITING: "waiting",
  OFFERED: "offered",
  PAYMENT_PENDING: "payment_pending",
  CONFIRMED: "confirmed",
  DECLINED: "declined",
  EXPIRED: "expired",
  WITHDRAWN: "withdrawn",
  CANCELLED: "cancelled",
} as const;

export const WAITLIST_STATES = Object.values(WAITLIST_STATE);

export const WAITLIST_LIVE_STATES = [
  WAITLIST_STATE.WAITING,
  WAITLIST_STATE.OFFERED,
  WAITLIST_STATE.PAYMENT_PENDING,
] as const;

export const WAITLIST_TERMINAL_STATES = [
  WAITLIST_STATE.CONFIRMED,
  WAITLIST_STATE.DECLINED,
  WAITLIST_STATE.EXPIRED,
  WAITLIST_STATE.WITHDRAWN,
  WAITLIST_STATE.CANCELLED,
] as const;

export const DEFAULT_WAITLIST_SETTINGS = Object.freeze({
  enabled: false,
  autoPromote: true,
  offerWindowHours: 24,
  cutoffHours: 2,
});

export const WAITLIST_SETTINGS_LIMITS = Object.freeze({
  offerWindowHours: { min: 1, max: 168 },
  cutoffHours: { min: 0, max: 168 },
});

export const WAITLIST_TOKEN_PURPOSE = {
  VERIFY: "verify",
  MANAGE: "manage",
  OFFER: "offer",
} as const;

export const WAITLIST_VERIFICATION_TTL_MS = 30 * 60 * 1000;
export const WAITLIST_MANAGEMENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const WAITLIST_MANAGEMENT_AFTER_SESSION_GRACE_MS =
  30 * 24 * 60 * 60 * 1000;
export const WAITLIST_CHECKOUT_MINIMUM_WINDOW_MS = 30 * 60 * 1000;

export const WAITLIST_EMAIL_TYPE = {
  VERIFY: "waitlist_verify",
  JOINED: "waitlist_joined",
  OFFERED: "waitlist_offered",
  EXPIRED: "waitlist_expired",
  WITHDRAWN: "waitlist_withdrawn",
  CANCELLED: "waitlist_cancelled",
  CONFIRMED: "waitlist_confirmed",
  REFUNDED: "waitlist_refunded",
} as const;

export const WAITLIST_ADMIN_ACTION = {
  SETTINGS_UPDATED: "settings_updated",
  PROMOTED: "promoted",
  OFFER_RESENT: "offer_resent",
  DECLINED: "declined",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  PARTICIPANT_REMOVED: "participant_removed",
} as const;
