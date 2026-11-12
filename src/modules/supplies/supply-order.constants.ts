export const SUPPLY_ORDER_STATUS = {
  NEW: "new",
  PRICED: "priced",
  APPROVED: "approved",
  IN_PROGRESS: "in_progress",
  READY: "ready",
  PICKED_UP: "picked_up",
  CANCELLED: "cancelled",
} as const;

export type SupplyOrderStatus =
  (typeof SUPPLY_ORDER_STATUS)[keyof typeof SUPPLY_ORDER_STATUS];

export const SUPPLY_ORDER_PRIORITY = {
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  URGENT: "urgent",
} as const;

export type SupplyOrderPriority =
  (typeof SUPPLY_ORDER_PRIORITY)[keyof typeof SUPPLY_ORDER_PRIORITY];

export const DEFAULT_SUPPLY_ORDER_PAGE = 1;
export const DEFAULT_SUPPLY_ORDER_LIMIT = 50;
export const MAX_SUPPLY_ORDER_LIMIT = 100;

export const SUPPLY_ORDER_SORT_FIELD = {
  CREATED_AT: "createdAt",
  REGISTERED_AT: "registeredAt",
  DEADLINE: "deadline",
  STATUS: "status",
  PRIORITY: "priority",
} as const;

export type SupplyOrderSortField =
  (typeof SUPPLY_ORDER_SORT_FIELD)[keyof typeof SUPPLY_ORDER_SORT_FIELD];

export const SORT_DIRECTION = {
  ASC: "asc",
  DESC: "desc",
} as const;

export type SortDirection = (typeof SORT_DIRECTION)[keyof typeof SORT_DIRECTION];

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
