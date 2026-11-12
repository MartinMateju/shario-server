/**
 * Product-kind contract V2.
 *
 * `kind` is additive during rollout. The existing persisted `type` remains a
 * compatibility projection until every old client and worker has been
 * retired. Do not use this module to rewrite or remove the legacy field.
 */
export const PRODUCT_KIND_CONTRACT_VERSION = 2 as const;

export const PRODUCT_KIND = {
  OPEN_STUDIO: "open-studio",
  CLASS: "class",
  MEMBERSHIP: "membership",
  VOUCHER: "voucher",
  PRIVATE_STUDIO: "private-studio",
} as const;

export type ProductKind = (typeof PRODUCT_KIND)[keyof typeof PRODUCT_KIND];

export const PRODUCT_KINDS = Object.freeze(
  Object.values(PRODUCT_KIND),
) as readonly ProductKind[];

/**
 * Sharing is a reservation policy for Open Studio. It is deliberately not a
 * product kind: a private Open Studio reservation is still Open Studio, while
 * Private Studio is an internal calendar block and has no customer booking
 * mode.
 */
export const OPEN_STUDIO_BOOKING_MODE = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const;

export type OpenStudioBookingMode =
  (typeof OPEN_STUDIO_BOOKING_MODE)[keyof typeof OPEN_STUDIO_BOOKING_MODE];

export const OPEN_STUDIO_BOOKING_MODES = Object.freeze(
  Object.values(OPEN_STUDIO_BOOKING_MODE),
) as readonly OpenStudioBookingMode[];

/** Product configuration; actual reservations always remain public/private. */
export const PRODUCT_OPEN_STUDIO_BOOKING_MODE = {
  ...OPEN_STUDIO_BOOKING_MODE,
  CUSTOMER_CHOICE: "customer-choice",
} as const;

export type ProductOpenStudioBookingMode =
  (typeof PRODUCT_OPEN_STUDIO_BOOKING_MODE)[keyof typeof PRODUCT_OPEN_STUDIO_BOOKING_MODE];

export const PRODUCT_OPEN_STUDIO_BOOKING_MODES = Object.freeze(
  Object.values(PRODUCT_OPEN_STUDIO_BOOKING_MODE),
) as readonly ProductOpenStudioBookingMode[];

export type OpenStudioPolicy = {
  publicCapacityMode: "fixed" | "activity";
  /** Total occupants, including the customer who starts the booking. */
  publicCapacityLimit: number | null;
  /** Flat amount charged once for an entire private reservation. */
  privateBookingSurcharge: number;
};

export const DEFAULT_OPEN_STUDIO_POLICY: Readonly<OpenStudioPolicy> = Object.freeze({
  publicCapacityMode: "activity",
  publicCapacityLimit: null,
  privateBookingSurcharge: 0,
});

export type OpenStudioBookingPolicy = Readonly<{
  allowedModes: readonly OpenStudioBookingMode[];
  defaultMode: OpenStudioBookingMode;
}>;

export const DEFAULT_OPEN_STUDIO_BOOKING_POLICY: OpenStudioBookingPolicy =
  Object.freeze({
    allowedModes: Object.freeze([
      OPEN_STUDIO_BOOKING_MODE.PUBLIC,
      OPEN_STUDIO_BOOKING_MODE.PRIVATE,
    ]),
    defaultMode: OPEN_STUDIO_BOOKING_MODE.PUBLIC,
  });

export type ProductKindCapabilities = Readonly<{
  customerBookable: boolean;
  sellable: boolean;
  internalOnly: boolean;
  supportsOpenStudioBookingMode: boolean;
}>;

export const PRODUCT_KIND_CAPABILITIES = Object.freeze({
  [PRODUCT_KIND.OPEN_STUDIO]: Object.freeze({
    customerBookable: true,
    sellable: true,
    internalOnly: false,
    supportsOpenStudioBookingMode: true,
  }),
  [PRODUCT_KIND.CLASS]: Object.freeze({
    customerBookable: true,
    sellable: true,
    internalOnly: false,
    supportsOpenStudioBookingMode: false,
  }),
  [PRODUCT_KIND.MEMBERSHIP]: Object.freeze({
    customerBookable: false,
    sellable: true,
    internalOnly: false,
    supportsOpenStudioBookingMode: false,
  }),
  [PRODUCT_KIND.VOUCHER]: Object.freeze({
    customerBookable: false,
    sellable: true,
    internalOnly: false,
    supportsOpenStudioBookingMode: false,
  }),
  [PRODUCT_KIND.PRIVATE_STUDIO]: Object.freeze({
    customerBookable: false,
    sellable: false,
    internalOnly: true,
    supportsOpenStudioBookingMode: false,
  }),
}) satisfies Readonly<Record<ProductKind, ProductKindCapabilities>>;

export const PRODUCT_KIND_MANUAL_REVIEW_REASON = {
  SERVICE_USAGE_AMBIGUOUS: "service-usage-ambiguous",
  GENERIC_MEMBERSHIP_REQUIRES_PLAN_MIGRATION:
    "generic-membership-requires-plan-migration",
  CREDIT_PACK_REQUIRES_PLAN_MIGRATION: "credit-pack-requires-plan-migration",
  REMOVED_RETAIL_KIND: "removed-retail-kind",
  UNKNOWN_LEGACY_TYPE: "unknown-legacy-type",
  INVALID_EXISTING_KIND: "invalid-existing-kind",
  EXISTING_KIND_CONFLICT: "existing-kind-conflict",
  INVALID_OPEN_STUDIO_BOOKING_MODE: "invalid-open-studio-booking-mode",
  MISSING_OPEN_STUDIO_BOOKING_MODE: "missing-open-studio-booking-mode",
  UNEXPECTED_OPEN_STUDIO_BOOKING_MODE: "unexpected-open-studio-booking-mode",
} as const;

export type ProductKindManualReviewReason =
  (typeof PRODUCT_KIND_MANUAL_REVIEW_REASON)[keyof typeof PRODUCT_KIND_MANUAL_REVIEW_REASON];

export const SYSTEM_OWNED_LEGACY_PRODUCT_TYPES = Object.freeze([
  "booking-addon",
  "guest-increase",
  "prolong",
  "system",
]) as readonly string[];

export type LegacyProductTypeResolution =
  | Readonly<{
      status: "mapped";
      kind: ProductKind;
      openStudioBookingPolicy?: OpenStudioBookingPolicy;
    }>
  | Readonly<{
      status: "manual-review";
      reason: ProductKindManualReviewReason;
    }>
  | Readonly<{
      status: "system-owned";
      reason: "system-owned-product";
    }>;

const normalizeValue = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const publicOnlyOpenStudioPolicy: OpenStudioBookingPolicy = Object.freeze({
  allowedModes: Object.freeze([OPEN_STUDIO_BOOKING_MODE.PUBLIC]),
  defaultMode: OPEN_STUDIO_BOOKING_MODE.PUBLIC,
});

const privateOnlyOpenStudioPolicy: OpenStudioBookingPolicy = Object.freeze({
  allowedModes: Object.freeze([OPEN_STUDIO_BOOKING_MODE.PRIVATE]),
  defaultMode: OPEN_STUDIO_BOOKING_MODE.PRIVATE,
});

const classTypes = new Set([
  "class",
  "course",
  "public-course",
  "private-course",
]);

const voucherTypes = new Set(["voucher", "coupon", "gift-card"]);

const systemOwnedTypes = new Set(SYSTEM_OWNED_LEGACY_PRODUCT_TYPES);

/**
 * Resolves only product-collection values that are safe to migrate without
 * inspecting tenant business data. In particular, a legacy `membership`
 * Product must not be mistaken for the authoritative MembershipPlan
 * aggregate, and a generic `service` may represent either timed studio access
 * or another standalone service.
 */
export const resolveLegacyProductTypeV2 = (
  value: unknown,
): LegacyProductTypeResolution => {
  const type = normalizeValue(value);

  if (classTypes.has(type)) {
    return { status: "mapped", kind: PRODUCT_KIND.CLASS };
  }

  if (type === "open-studio" || type === "workshop") {
    return {
      status: "mapped",
      kind: PRODUCT_KIND.OPEN_STUDIO,
      openStudioBookingPolicy: DEFAULT_OPEN_STUDIO_BOOKING_POLICY,
    };
  }

  if (type === "public-workshop") {
    return {
      status: "mapped",
      kind: PRODUCT_KIND.OPEN_STUDIO,
      openStudioBookingPolicy: publicOnlyOpenStudioPolicy,
    };
  }

  if (type === "private-workshop") {
    return {
      status: "mapped",
      kind: PRODUCT_KIND.OPEN_STUDIO,
      openStudioBookingPolicy: privateOnlyOpenStudioPolicy,
    };
  }

  if (voucherTypes.has(type)) {
    return { status: "mapped", kind: PRODUCT_KIND.VOUCHER };
  }

  if (type === "private-studio" || type === "blocker") {
    return { status: "mapped", kind: PRODUCT_KIND.PRIVATE_STUDIO };
  }

  if (type === "service") {
    return {
      status: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.SERVICE_USAGE_AMBIGUOUS,
    };
  }

  if (type === "membership") {
    return {
      status: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.GENERIC_MEMBERSHIP_REQUIRES_PLAN_MIGRATION,
    };
  }

  if (type === "credit-pack") {
    return {
      status: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.CREDIT_PACK_REQUIRES_PLAN_MIGRATION,
    };
  }

  if (type === "physical-product") {
    return {
      status: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.REMOVED_RETAIL_KIND,
    };
  }

  if (systemOwnedTypes.has(type)) {
    return { status: "system-owned", reason: "system-owned-product" };
  }

  return {
    status: "manual-review",
    reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.UNKNOWN_LEGACY_TYPE,
  };
};

export const normalizeProductKindV2 = (value: unknown): ProductKind | null => {
  const normalized = normalizeValue(value);

  return PRODUCT_KINDS.includes(normalized as ProductKind)
    ? (normalized as ProductKind)
    : null;
};

export const normalizeOpenStudioBookingMode = (
  value: unknown,
): OpenStudioBookingMode | null => {
  const normalized = normalizeValue(value);

  return OPEN_STUDIO_BOOKING_MODES.includes(normalized as OpenStudioBookingMode)
    ? (normalized as OpenStudioBookingMode)
    : null;
};

export const normalizeProductOpenStudioBookingMode = (
  value: unknown,
): ProductOpenStudioBookingMode | null => {
  const normalized = normalizeValue(value);
  return PRODUCT_OPEN_STUDIO_BOOKING_MODES.includes(normalized as ProductOpenStudioBookingMode)
    ? (normalized as ProductOpenStudioBookingMode)
    : null;
};

/**
 * Resolves the additive V2 field first and the deprecated `bookingType` alias
 * second. Non-Open-Studio kinds intentionally return null—even when the alias
 * says "private"—so a private reservation can never be reclassified as the
 * internal-only Private Studio product.
 */
export const resolveOpenStudioBookingModeV2 = ({
  kind,
  bookingMode,
  bookingType,
}: {
  kind: unknown;
  bookingMode?: unknown;
  bookingType?: unknown;
}): OpenStudioBookingMode | null => {
  if (normalizeProductKindV2(kind) !== PRODUCT_KIND.OPEN_STUDIO) return null;

  return (
    normalizeOpenStudioBookingMode(bookingMode) ??
    normalizeOpenStudioBookingMode(bookingType)
  );
};

/**
 * Temporary projection for old code paths. Membership has no Product
 * compatibility type because MembershipPlan is its authoritative aggregate.
 */
export const getLegacyCompatibilityTypeForKind = (
  kind: unknown,
): string | null => {
  switch (normalizeProductKindV2(kind)) {
    case PRODUCT_KIND.OPEN_STUDIO:
      return "workshop";
    case PRODUCT_KIND.CLASS:
      return "course";
    case PRODUCT_KIND.VOUCHER:
      return "coupon";
    case PRODUCT_KIND.PRIVATE_STUDIO:
      return "blocker";
    default:
      return null;
  }
};
