/**
 * Booking constants
 * Single source of truth for booking-related values.
 */

export const NOTIFICATION_CHANNEL = {
  EMAIL: "email",
  IN_APP: "in-app",
} as const;

export type NotificationChannel =
  (typeof NOTIFICATION_CHANNEL)[keyof typeof NOTIFICATION_CHANNEL] | null;

export const BOOKING_TAG = {
  OPEN_STUDIO: "open-studio",
  CLASS: "class",
  PRIVATE_STUDIO: "private-studio",
  /** @deprecated Read-only compatibility for historical bookings. */
  WORKSHOP: "workshop",
  /** @deprecated Read-only compatibility for historical bookings. */
  COURSE: "course",
  /** @deprecated Read-only compatibility for historical internal blocks. */
  PRIVATE_SESSION: "private-session",
  GUEST_INCREASE: "guest-increase",
  EXTENSION_HOLD: "extension-hold",
} as const;

export type BookingTag = (typeof BOOKING_TAG)[keyof typeof BOOKING_TAG];

export const OPEN_STUDIO_BOOKING_TAGS = [
  BOOKING_TAG.OPEN_STUDIO,
  BOOKING_TAG.WORKSHOP,
] as const satisfies readonly BookingTag[];

export const CLASS_BOOKING_TAGS = [
  BOOKING_TAG.CLASS,
  BOOKING_TAG.COURSE,
] as const satisfies readonly BookingTag[];

export const INTERNAL_STUDIO_BOOKING_TAGS = [
  BOOKING_TAG.PRIVATE_STUDIO,
  BOOKING_TAG.PRIVATE_SESSION,
] as const satisfies readonly BookingTag[];

export const BOOKING_STATUS = {
  PENDING: "pending",
  PROCESSED: "processed",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
} as const;

export type BookingStatus =
  (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

export const PAYMENT_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
} as const;

export type PaymentStatus =
  (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const BOOKING_TYPE = {
  PRIVATE: "private",
  PUBLIC: "public",
} as const;

export type BookingType = (typeof BOOKING_TYPE)[keyof typeof BOOKING_TYPE];

export const BOOKING_LANGUAGE = {
  CZ: "cz",
  CS: "cs",
  EN: "en",
} as const;

export type BookingLanguage =
  (typeof BOOKING_LANGUAGE)[keyof typeof BOOKING_LANGUAGE];

export const PLANNED_ACTIVITY = {
  WORKSTATION: "WORKSTATION",
  SHARED_TABLE: "SHARED_TABLE",
  UNDEFINED: "UNDEFINED",
} as const;

export type PlannedActivity =
  (typeof PLANNED_ACTIVITY)[keyof typeof PLANNED_ACTIVITY];

export const SUPPORTED_LANGUAGES = Object.values(BOOKING_LANGUAGE);

export const DEFAULT_LANGUAGE: BookingLanguage = BOOKING_LANGUAGE.CZ;

export const SLOT_MINUTES = 30;
