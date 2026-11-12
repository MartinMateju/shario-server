export const CHECKOUT_STATUSES = {
  PENDING_ORDER: "pending_order",
  PROCESSED_ORDER: "processed_order",
  FAILED_ORDER: "failed_order",
  CANCELLED_ORDER: "cancelled_order",
} as const;

export type CheckoutStatus =
  (typeof CHECKOUT_STATUSES)[keyof typeof CHECKOUT_STATUSES];

export const PAYMENT_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  CONFIRMED: "CONFIRMED",
} as const;

export type CheckoutPaymentStatus =
  (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const BOOKING_STATUS = {
  PENDING: "pending",
  PROCESSED: "processed",
  CANCELLED: "cancelled",
} as const;

export type CheckoutBookingStatus =
  (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

export const BOOKING_TAG = {
  OPEN_STUDIO: "open-studio",
  CLASS: "class",
  PRIVATE_STUDIO: "private-studio",
  /** @deprecated */
  WORKSHOP: "workshop",
  /** @deprecated */
  COURSE: "course",
  GUEST_INCREASE: "guest-increase",
} as const;

export type CheckoutBookingTag = (typeof BOOKING_TAG)[keyof typeof BOOKING_TAG];

export const VALID_PRODUCT_TYPES = [
  // Canonical product taxonomy.
  "course",
  "workshop",
  // Legacy booking taxonomy still used by the current frontend.
  "public-course",
  "private-course",
  "public-workshop",
  "private-workshop",
  // Standalone services cover non-booking work offered by a shared space.
  "service",
  "prolong",
  "blocker",
  "guest-increase",
] as const;

export type ValidProductType = (typeof VALID_PRODUCT_TYPES)[number];

export const VALID_GUEST_PRODUCT_TYPES = [
  ...VALID_PRODUCT_TYPES,
  "coupon",
] as const;

export type ValidGuestProductType = (typeof VALID_GUEST_PRODUCT_TYPES)[number];

// Legacy guest-voucher validation still imports these checkout constants.
// Keep them here until that service is fully consolidated with coupon.constants.
export const PROMO_CODE_REGEX = /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/;

export const RESERVE_MINUTES = 5;

/**
 * A checkout request must never be able to create an unbounded participant
 * list. Course products can configure a lower slot capacity; this value is a
 * defensive upper bound for a single line when no lower product limit exists.
 */
export const MAX_COURSE_PARTICIPANTS_PER_ITEM = 100;

/**
 * Limits the total number of course participants represented by one checkout
 * request. This also keeps order snapshots and webhook fulfillment bounded
 * when a cart contains several different course slots.
 */
export const MAX_COURSE_PARTICIPANTS_PER_CHECKOUT = 200;

export const MAX_GUEST_INCREASE_PER_ITEM = 20;
export const MAX_GUEST_INCREASE_BLOCKS = 48;

// Stripe requires expires_at to be at least 30 minutes in the future when the
// API call reaches Stripe. Five minutes of server-side headroom keeps that
// invariant true while checkout snapshots and capacity holds are persisted.
export const STRIPE_CHECKOUT_SESSION_MINUTES = 35;

/**
 * Keep capacity held briefly beyond Stripe's Session expiry. This avoids
 * releasing seats while a paid event that occurred just before expiry is
 * still in webhook delivery.
 */
export const COURSE_RESERVATION_SAFETY_MINUTES = 24 * 60;

// Pending Open Studio bookings can be paid at the same last instant as Class
// seats. Keep both capacity reservations fail-closed for the same delayed-
// webhook window; checkout.session.expired still releases them immediately.
export const WORKSHOP_RESERVATION_GRACE_MINUTES =
  COURSE_RESERVATION_SAFETY_MINUTES;

export const STRIPE_ALLOWED_COMPLETED_EVENTS = new Set<string>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export const STRIPE_CHECKOUT_SESSION_EXPIRED_EVENT = "checkout.session.expired";
