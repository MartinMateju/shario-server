export const ORDER_STATUS = {
  PENDING: "pending_order",
  PROCESSED: "processed_order",
  FAILED: "failed_order",
  CANCELLED: "cancelled_order",
} as const;

export const ORDER_NOTIFICATION_TYPE = {
  ORDER_CONFIRM: "order_confirm",
  COURSE_CONFIRM: "course_confirm",
  WORKSHOP_CONFIRM: "workshop_confirm",
  CREDITS_PURCHASE_CONFIRM: "credits_purchase_confirm",
} as const;

export const ORDER_NOTIFICATION_CHANNEL = {
  EMAIL: "email",
} as const;

export const ORDER_NOTIFICATION_STATUS = {
  PROCESSING: "PROCESSING",
  SENT: "SENT",
  FAILED: "FAILED",
  AMBIGUOUS: "AMBIGUOUS",
} as const;

export const ORDER_SORT_FIELD = {
  CREATED_AT: "createdAt",
  PAID_AT: "paidAt",
  STATUS: "status",
} as const;

export const ORDER_SORT_ORDER = {
  ASC: "asc",
  DESC: "desc",
} as const;

export const DEFAULT_ORDER_PAGE = 1;
export const DEFAULT_ORDER_LIMIT = 8;
export const MAX_ORDER_LIMIT = 100;

export const ORDER_CONFIRM_NOTIFICATION_TYPE =
  ORDER_NOTIFICATION_TYPE.ORDER_CONFIRM;

export const ORDER_NOTIFICATION_MAX_RETRIES = 3;
export const ORDER_NOTIFICATION_RETRY_DELAY_MS = 15 * 60 * 1000;
export const ORDER_NOTIFICATION_LOCK_MS = 2 * 60 * 1000;
export const ORDER_NOTIFICATION_BATCH_LIMIT = 50;
export const ORDER_NOTIFICATION_FIRST_SEND_WINDOW_HOURS = 2;
export const ORDER_NOTIFICATION_FALLBACK_SEND_WINDOW_HOURS = 12;
export const ORDER_NOTIFICATION_RETRY_WINDOW_HOURS = 12;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export type OrderNotificationType =
  (typeof ORDER_NOTIFICATION_TYPE)[keyof typeof ORDER_NOTIFICATION_TYPE];
export type OrderNotificationChannel =
  (typeof ORDER_NOTIFICATION_CHANNEL)[keyof typeof ORDER_NOTIFICATION_CHANNEL];
export type OrderNotificationStatus =
  (typeof ORDER_NOTIFICATION_STATUS)[keyof typeof ORDER_NOTIFICATION_STATUS];
export type OrderSortField =
  (typeof ORDER_SORT_FIELD)[keyof typeof ORDER_SORT_FIELD];
export type OrderSortOrder =
  (typeof ORDER_SORT_ORDER)[keyof typeof ORDER_SORT_ORDER];
