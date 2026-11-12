import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  STUDIO_COMMERCE_CURRENCIES,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

export const PRODUCT_TYPE = {
  COURSE: "course",
  WORKSHOP: "workshop",
  MEMBERSHIP: "membership",
  CREDIT_PACK: "credit-pack",
  GIFT_CARD: "gift-card",
  PHYSICAL_PRODUCT: "physical-product",
  COUPON: "coupon",
  SERVICE: "service",
  BOOKING_ADDON: "booking-addon",
  SYSTEM: "system",
} as const;

export type CanonicalProductType =
  (typeof PRODUCT_TYPE)[keyof typeof PRODUCT_TYPE];

/**
 * Transitional values still emitted by the existing booking UI. They remain
 * accepted until stored products and cart payloads are migrated to the
 * canonical `course` / `workshop` taxonomy.
 */
export const LEGACY_BOOKING_PRODUCT_TYPE = {
  PUBLIC_COURSE: "public-course",
  PRIVATE_COURSE: "private-course",
  PUBLIC_WORKSHOP: "public-workshop",
  PRIVATE_WORKSHOP: "private-workshop",
  GUEST_INCREASE: "guest-increase",
  PROLONG: "prolong",
  BLOCKER: "blocker",
} as const;

export type LegacyBookingProductType =
  (typeof LEGACY_BOOKING_PRODUCT_TYPE)[keyof typeof LEGACY_BOOKING_PRODUCT_TYPE];

export type ProductType = CanonicalProductType | LegacyBookingProductType;

export const PRODUCT_TYPES = [
  ...Object.values(PRODUCT_TYPE),
  ...Object.values(LEGACY_BOOKING_PRODUCT_TYPE),
] as const;

/**
 * Product types that may be exposed through the unauthenticated studio
 * catalog. Operational products (for example guest increases and blockers)
 * are deliberately excluded even when they are active.
 */
export const PUBLIC_PRODUCT_TYPES = [
  PRODUCT_TYPE.COURSE,
  PRODUCT_TYPE.WORKSHOP,
  PRODUCT_TYPE.GIFT_CARD,
  PRODUCT_TYPE.COUPON,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP,
  LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_WORKSHOP,
] as const satisfies readonly ProductType[];

/**
 * Customer-bookable offers require an explicit capacity. Keeping this list in
 * the product module prevents Setup Center, validation and checkout-adjacent
 * code from drifting onto different product taxonomies.
 */
export const BOOKABLE_PRODUCT_TYPES = [
  PRODUCT_TYPE.COURSE,
  PRODUCT_TYPE.WORKSHOP,
  PRODUCT_TYPE.SERVICE,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE,
  LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_COURSE,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP,
  LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_WORKSHOP,
] as const satisfies readonly ProductType[];

export const COURSE_PRODUCT_TYPES = [
  PRODUCT_TYPE.COURSE,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE,
  LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_COURSE,
] as const satisfies readonly ProductType[];

export const PUBLIC_COURSE_PRODUCT_TYPES = [
  PRODUCT_TYPE.COURSE,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE,
] as const satisfies readonly ProductType[];

export const PRODUCT_CURRENCY = Object.freeze(
  Object.fromEntries(
    STUDIO_COMMERCE_CURRENCIES.map((currency) => [currency, currency]),
  ) as Record<StudioCommerceCurrency, StudioCommerceCurrency>,
);

export type ProductCurrency = StudioCommerceCurrency;

export const DEFAULT_PRODUCT_CURRENCY = DEFAULT_STUDIO_COMMERCE_CURRENCY;
export const DEFAULT_PRODUCT_LIMIT = 50;
export const MAX_PRODUCT_LIMIT = 100;
export const MAX_PRODUCT_NAME_LENGTH = 160;
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 5000;
export const MAX_PRODUCT_CLASS_CATEGORY_LENGTH = 120;
export const MAX_PRODUCT_LABEL_LENGTH = 120;
export const MAX_PRODUCT_SKU_LENGTH = 120;
export const MAX_PRODUCT_SEARCH_LENGTH = 160;
export const MAX_PRODUCT_IMAGE_SRC_LENGTH = 2048;
export const MAX_PRODUCT_TEMPLATE_KEY_LENGTH = 1024;
export const MIN_PRODUCT_PARTICIPANTS = 1;
export const MAX_PRODUCT_PARTICIPANTS = 500;
export const COUPON_TEMPLATE_MAX_MB = 10;

export const PRODUCT_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type ProductImageMediaType = (typeof PRODUCT_IMAGE_MEDIA_TYPES)[number];

export const PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_WIDTH = 6_000;
export const PRODUCT_IMAGE_MAX_HEIGHT = 6_000;
export const PRODUCT_IMAGE_MAX_PIXELS = 24_000_000;
