export const COMMUNICATION_EMAIL_LOG_STATUS = {
  PENDING: "pending",
  SCHEDULED: "scheduled",
  QUEUED: "queued",
  SENDING: "sending",
  AMBIGUOUS: "ambiguous",
  SENT: "sent",
  DELIVERED: "delivered",
  FAILED: "failed",
  BOUNCED: "bounced",
  COMPLAINED: "complained",
  CANCELED: "canceled",
  SUPPRESSED: "suppressed",
} as const;

export type CommunicationEmailLogStatus =
  (typeof COMMUNICATION_EMAIL_LOG_STATUS)[keyof typeof COMMUNICATION_EMAIL_LOG_STATUS];

export const COMMUNICATION_EMAIL_TYPE = {
  FIRING_READY: "firingReady",
  BOOKING_CANCELLED: "bookingCancelled",
  BOOKING_RESCHEDULED: "bookingRescheduled",
  BOOKING_EXTENDED: "bookingExtended",
  BEFORE_BOOKING: "beforeBooking",
  AFTER_BOOKING_CREATED: "afterBookingCreated",
  AFTER_BOOKING: "afterBooking",
  BEFORE_PURCHASE: "beforePurchase",
  AFTER_PURCHASE: "afterPurchase",
  AFTER_BISQUE_FIRING: "afterBisqueFiring",
  AFTER_FINAL_FIRING: "afterFinalFiring",
  PASSWORD_RESET: "passwordReset",
  AFTER_REGISTRATION: "afterRegistration",
  ONE_TIME_EMAIL: "oneTimeEmail",
  AFTER_ITEM_REGISTERED: "afterItemRegistered",
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
} as const;

export type CommunicationEmailType =
  (typeof COMMUNICATION_EMAIL_TYPE)[keyof typeof COMMUNICATION_EMAIL_TYPE];

export const COMMUNICATION_EMAIL_LOG_STATUS_VALUES = Object.values(
  COMMUNICATION_EMAIL_LOG_STATUS,
) as [CommunicationEmailLogStatus, ...CommunicationEmailLogStatus[]];

export const COMMUNICATION_EMAIL_TYPE_VALUES = Object.values(
  COMMUNICATION_EMAIL_TYPE,
) as [CommunicationEmailType, ...CommunicationEmailType[]];

export const COMMUNICATION_EMAIL_ALLOWANCE_CLASS = {
  METERED: "metered",
  ESSENTIAL_SYSTEM: "essential_system",
} as const;

export type CommunicationEmailAllowanceClass =
  (typeof COMMUNICATION_EMAIL_ALLOWANCE_CLASS)[keyof typeof COMMUNICATION_EMAIL_ALLOWANCE_CLASS];

export const COMMUNICATION_EMAIL_ALLOWANCE_CLASS_VALUES = Object.values(
  COMMUNICATION_EMAIL_ALLOWANCE_CLASS,
) as [CommunicationEmailAllowanceClass, ...CommunicationEmailAllowanceClass[]];

/** Only server-created lifecycle records may bypass editable automation rules. */
export const isBookingLifecycleEmailLog = (log: {
  emailType?: unknown;
  automation?: unknown;
  purpose?: unknown;
  allowanceClass?: unknown;
}): boolean =>
  (log.emailType === COMMUNICATION_EMAIL_TYPE.BOOKING_CANCELLED ||
    log.emailType === COMMUNICATION_EMAIL_TYPE.BOOKING_RESCHEDULED ||
    log.emailType === COMMUNICATION_EMAIL_TYPE.BOOKING_EXTENDED) &&
  log.automation == null &&
  log.purpose === "transactional" &&
  log.allowanceClass === COMMUNICATION_EMAIL_ALLOWANCE_CLASS.ESSENTIAL_SYSTEM;

/** Immutable notices created by the firing workflow, never tenant automations. */
export const isFiringReadyEmailLog = (log: {
  emailType?: unknown;
  automation?: unknown;
  purpose?: unknown;
  allowanceClass?: unknown;
}): boolean =>
  log.emailType === COMMUNICATION_EMAIL_TYPE.FIRING_READY &&
  log.automation == null &&
  log.purpose === "transactional" &&
  log.allowanceClass === COMMUNICATION_EMAIL_ALLOWANCE_CLASS.ESSENTIAL_SYSTEM;

export const isBuiltInLifecycleEmailLog = (
  log: Parameters<typeof isBookingLifecycleEmailLog>[0],
): boolean => isBookingLifecycleEmailLog(log) || isFiringReadyEmailLog(log);

/** Explicit known-unsent retries get a bounded cycle without erasing history. */
export const getCommunicationEmailAttemptLimit = (
  log: Parameters<typeof isFiringReadyEmailLog>[0] & {
    attempts?: unknown;
    retryCycleStartAttempt?: unknown;
  },
  baseLimit: number,
): number => {
  const cycleStart = Number(log.retryCycleStartAttempt || 0);
  const validatedStart =
    isFiringReadyEmailLog(log) &&
    Number.isSafeInteger(cycleStart) &&
    cycleStart >= 0 &&
    cycleStart <= Number(log.attempts || 0)
      ? cycleStart
      : 0;
  return baseLimit + validatedStart;
};

export const DEFAULT_EMAIL_LOG_PAGE = 1;
export const DEFAULT_EMAIL_LOG_LIMIT = 50;
export const MAX_EMAIL_LOG_LIMIT = 200;

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
