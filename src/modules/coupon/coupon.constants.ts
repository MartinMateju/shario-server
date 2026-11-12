import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

export const COUPON_STATUS = {
  PENDING_PAYMENT: "pending_coupon_payment",
  EXPIRED: "expired_coupon_payment",
  PROCESSED: "processed_coupon",
  SHIPPED: "shipped_coupon",
} as const;

export type CouponOrderStatus =
  (typeof COUPON_STATUS)[keyof typeof COUPON_STATUS];

export const COUPON_STATUSES = Object.values(COUPON_STATUS);

export const COUPON_SORT_FIELD = {
  CREATED_AT: "createdAt",
  STATUS: "status",
  PRODUCT_NAME: "productNameSnapshot",
} as const;

export type CouponSortField =
  (typeof COUPON_SORT_FIELD)[keyof typeof COUPON_SORT_FIELD];

export const SORT_ORDER = {
  ASC: "asc",
  DESC: "desc",
} as const;

export type SortOrder = (typeof SORT_ORDER)[keyof typeof SORT_ORDER];

export const PROMO_CODE_REGEX = /^(?=.{8,64}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export const PROMO_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const DEFAULT_COUPON_PAGE = 1;
export const DEFAULT_COUPON_LIMIT = 8;
export const MAX_COUPON_LIMIT = 100;

export const POST_FEE_CZK = 90;

/**
 * Postage is a real price, not an exchange-rate conversion. Until a tenant can
 * configure per-currency postage, only the historical CZK fee is supported.
 * Digital vouchers continue to work in every studio commerce currency.
 */
export const COUPON_POST_FEE_BY_CURRENCY: Readonly<
  Partial<Record<StudioCommerceCurrency, number>>
> = {
  CZK: POST_FEE_CZK,
};

export const COUPON_STRIPE_CLIENT_REFERENCE_PREFIX = "CO_";
