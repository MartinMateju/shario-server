import {
  PRODUCT_KIND_CONTRACT_VERSION,
  PRODUCT_KIND,
  PRODUCT_KIND_MANUAL_REVIEW_REASON,
  normalizeProductOpenStudioBookingMode,
  normalizeProductKindV2,
  resolveLegacyProductTypeV2,
  type ProductOpenStudioBookingMode,
  type ProductKind,
  type ProductKindManualReviewReason,
} from "./product-kind-v2.contract.js";

export type ProductKindMigrationDocument = {
  _id: unknown;
  tenant?: unknown;
  name?: unknown;
  type?: unknown;
  kind?: unknown;
  kindContractVersion?: unknown;
  bookingMode?: unknown;
};

export type ProductKindMigrationPatch = Readonly<{
  kind: ProductKind;
  kindContractVersion: typeof PRODUCT_KIND_CONTRACT_VERSION;
  bookingMode?: ProductOpenStudioBookingMode;
}>;

export type ProductKindMigrationPlan =
  | Readonly<{
      action: "update";
      patch: ProductKindMigrationPatch;
    }>
  | Readonly<{
      action: "already-migrated";
      kind: ProductKind;
    }>
  | Readonly<{
      action: "manual-review";
      reason: ProductKindManualReviewReason;
    }>
  | Readonly<{
      action: "system-owned";
      reason: "system-owned-product";
    }>;

const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null && String(value).trim() !== "";

const isCanonicalPersistedValue = (
  value: unknown,
  normalized: string,
): boolean => String(value ?? "").trim() === normalized;

/**
 * Pure planner used by both the operational migration and unit tests. It
 * never overwrites an existing canonical kind. A conflict is reported for
 * manual review instead of guessing which side is authoritative.
 */
export const planProductKindV2Migration = (
  product: ProductKindMigrationDocument,
): ProductKindMigrationPlan => {
  const existingKind = normalizeProductKindV2(product.kind);
  const hasExistingKind = hasValue(product.kind);
  const legacyResolution = resolveLegacyProductTypeV2(product.type);
  const existingBookingMode = normalizeProductOpenStudioBookingMode(
    product.bookingMode,
  );

  if (
    hasExistingKind &&
    (!existingKind || !isCanonicalPersistedValue(product.kind, existingKind))
  ) {
    return {
      action: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.INVALID_EXISTING_KIND,
    };
  }

  if (existingKind) {
    if (legacyResolution.status === "system-owned") {
      return {
        action: "manual-review",
        reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.EXISTING_KIND_CONFLICT,
      };
    }

    if (existingKind === PRODUCT_KIND.MEMBERSHIP) {
      return {
        action: "manual-review",
        reason:
          PRODUCT_KIND_MANUAL_REVIEW_REASON.GENERIC_MEMBERSHIP_REQUIRES_PLAN_MIGRATION,
      };
    }

    if (
      legacyResolution.status === "mapped" &&
      legacyResolution.kind !== existingKind
    ) {
      return {
        action: "manual-review",
        reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.EXISTING_KIND_CONFLICT,
      };
    }

    if (existingKind === PRODUCT_KIND.OPEN_STUDIO) {
      if (!hasValue(product.bookingMode)) {
        return {
          action: "manual-review",
          reason:
            PRODUCT_KIND_MANUAL_REVIEW_REASON.MISSING_OPEN_STUDIO_BOOKING_MODE,
        };
      }

      if (
        !existingBookingMode ||
        !isCanonicalPersistedValue(product.bookingMode, existingBookingMode)
      ) {
        return {
          action: "manual-review",
          reason:
            PRODUCT_KIND_MANUAL_REVIEW_REASON.INVALID_OPEN_STUDIO_BOOKING_MODE,
        };
      }
    } else if (hasValue(product.bookingMode)) {
      return {
        action: "manual-review",
        reason:
          PRODUCT_KIND_MANUAL_REVIEW_REASON.UNEXPECTED_OPEN_STUDIO_BOOKING_MODE,
      };
    }

    return { action: "already-migrated", kind: existingKind };
  }

  if (legacyResolution.status === "manual-review") {
    return {
      action: "manual-review",
      reason: legacyResolution.reason,
    };
  }

  if (legacyResolution.status === "system-owned") {
    return {
      action: "system-owned",
      reason: legacyResolution.reason,
    };
  }

  if (
    legacyResolution.openStudioBookingPolicy &&
    hasValue(product.bookingMode) &&
    (!existingBookingMode ||
      !isCanonicalPersistedValue(product.bookingMode, existingBookingMode))
  ) {
    return {
      action: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.INVALID_OPEN_STUDIO_BOOKING_MODE,
    };
  }

  if (
    !legacyResolution.openStudioBookingPolicy &&
    hasValue(product.bookingMode)
  ) {
    return {
      action: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.UNEXPECTED_OPEN_STUDIO_BOOKING_MODE,
    };
  }

  return {
    action: "update",
    patch: {
      kind: legacyResolution.kind,
      kindContractVersion: PRODUCT_KIND_CONTRACT_VERSION,
      ...(!hasValue(product.bookingMode) &&
      legacyResolution.openStudioBookingPolicy
        ? {
            bookingMode: legacyResolution.openStudioBookingPolicy.defaultMode,
          }
        : {}),
    },
  };
};
