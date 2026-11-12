export const CART_STATUS = {
  ACTIVE: "active",
  CONVERTED: "converted",
  ABANDONED: "abandoned",
} as const;

export type CartStatus = (typeof CART_STATUS)[keyof typeof CART_STATUS];

export const CART_SORT_FIELD = {
  CREATED_AT: "createdAt",
  UPDATED_AT: "updatedAt",
  TOTAL_PRICE: "totalPrice",
  STATUS: "status",
} as const;

export type CartSortField =
  (typeof CART_SORT_FIELD)[keyof typeof CART_SORT_FIELD];

export const CART_DEFAULTS = {
  PAGE: 1,
  LIMIT: 20,
  MAX_LIMIT: 100,
} as const;
