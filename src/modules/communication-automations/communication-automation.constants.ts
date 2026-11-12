export const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const COMMUNICATION_SCHEDULE_TYPE = {
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

export const COMMUNICATION_CONNECTED_PRODUCT_TYPE = {
  ALL: "all",
  BOOKING: "booking",
  WORKSHOP: "workshop",
  COURSE: "course",
  PRIVATE_SESSION: "private-session",
  MEMBERSHIP: "membership",
  GIFT_CARD: "gift-card",
  CREDIT_PACK: "credit-pack",
  POTTERY_ITEM: "pottery-item",
} as const;

export const COMMUNICATION_AUTOMATION_STATUS = {
  DRAFT: "draft",
  WAITING_TO_ACTIVATE: "waiting_to_activate",
  ACTIVE: "active",
  INACTIVE: "inactive",
  FAILED: "failed",
} as const;

export const COMMUNICATION_DAY_OF_WEEK = {
  MONDAY: "monday",
  TUESDAY: "tuesday",
  WEDNESDAY: "wednesday",
  THURSDAY: "thursday",
  FRIDAY: "friday",
  SATURDAY: "saturday",
  SUNDAY: "sunday",
} as const;

export const DEFAULT_MINUTES_OFFSET = 1440;
export const DEFAULT_SEND_TIME = "09:00";
export const DEFAULT_DAY_OF_WEEK = COMMUNICATION_DAY_OF_WEEK.MONDAY;
export const DEFAULT_DAY_OF_MONTH = 1;
export const MAX_RECIPIENTS_PER_AUTOMATION = 500;
export const MAX_AUTOMATION_OFFSET_MINUTES = 525_600;

export const COMMUNICATION_CONTENT_LOCALE = {
  CS: "cs",
  EN: "en",
} as const;

export const COMMUNICATION_AUTOMATION_PURPOSE = {
  TRANSACTIONAL: "transactional",
  MARKETING: "marketing",
} as const;

export const RECURRING_COMMUNICATION_SCHEDULE_TYPES = new Set<string>([
  COMMUNICATION_SCHEDULE_TYPE.ONE_TIME_EMAIL,
  COMMUNICATION_SCHEDULE_TYPE.DAILY,
  COMMUNICATION_SCHEDULE_TYPE.WEEKLY,
  COMMUNICATION_SCHEDULE_TYPE.MONTHLY,
]);

export const BOOKING_COMMUNICATION_SCHEDULE_TYPES = new Set<string>([
  COMMUNICATION_SCHEDULE_TYPE.BEFORE_BOOKING,
  COMMUNICATION_SCHEDULE_TYPE.AFTER_BOOKING_CREATED,
  COMMUNICATION_SCHEDULE_TYPE.AFTER_BOOKING,
  // Backwards-compatible names used by the existing editor. These are
  // interpreted relative to a booked product's start/end, not as an attempt
  // to email an unknown customer before they purchase.
  COMMUNICATION_SCHEDULE_TYPE.BEFORE_PURCHASE,
  COMMUNICATION_SCHEDULE_TYPE.AFTER_PURCHASE,
]);

export const EVENT_COMMUNICATION_SCHEDULE_TYPES = new Set<string>([
  COMMUNICATION_SCHEDULE_TYPE.AFTER_REGISTRATION,
]);

export type CommunicationScheduleType =
  (typeof COMMUNICATION_SCHEDULE_TYPE)[keyof typeof COMMUNICATION_SCHEDULE_TYPE];

export type CommunicationConnectedProductType =
  (typeof COMMUNICATION_CONNECTED_PRODUCT_TYPE)[keyof typeof COMMUNICATION_CONNECTED_PRODUCT_TYPE];

export type CommunicationAutomationStatus =
  (typeof COMMUNICATION_AUTOMATION_STATUS)[keyof typeof COMMUNICATION_AUTOMATION_STATUS];

export type CommunicationDayOfWeek =
  (typeof COMMUNICATION_DAY_OF_WEEK)[keyof typeof COMMUNICATION_DAY_OF_WEEK];

export type CommunicationContentLocale =
  (typeof COMMUNICATION_CONTENT_LOCALE)[keyof typeof COMMUNICATION_CONTENT_LOCALE];

export type CommunicationAutomationPurpose =
  (typeof COMMUNICATION_AUTOMATION_PURPOSE)[keyof typeof COMMUNICATION_AUTOMATION_PURPOSE];

export const SHARIO_COMMUNICATION_SCHEDULE_TYPES = Object.values(COMMUNICATION_SCHEDULE_TYPE).filter((type) => !["afterBisqueFiring", "afterFinalFiring", "afterItemRegistered"].includes(type));
export const SHARIO_COMMUNICATION_PRODUCT_TYPES = Object.values(COMMUNICATION_CONNECTED_PRODUCT_TYPE).filter((type) => type !== "pottery-item");
